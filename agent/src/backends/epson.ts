import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Shell, txtToPs } from './shell.ts';
import type { FaxBackend, SendInput, SendResult } from './types.ts';

const POLL_MS = 3_000;
/** 복합기 연결을 다시 확인하는 간격. 두 번 연속 끊겨 있으면 멈춘 걸로 보고 취소한다 */
const LINK_CHECK_MS = 30_000;
/** 기다리는 최대 시간: 15분, 장수가 많으면 (3분 + 장당 2분) */
const MIN_WAIT_MIN = 15;
const DETAIL_MAX = 2000;

/**
 * Epson PC-Fax 2 Driver for Linux 의 epfax2 명령으로 보낸다.
 *   epfax2 -P <프린터> -o fax-number=<번호> <파일>
 * 드라이버는 CUPS 에 epsonfax2://<복합기 IP> 로 등록돼 있어야 한다.
 *
 * epfax2 는 CUPS 대기열에 넣고 바로 끝난다 ("request id is EPSON_FAX2-1").
 * 그래서 작업이 대기열에서 빠질 때까지 기다린 뒤 드라이버 로그로 결과를 판정한다.
 *   Start Fax           : Mon Oct 26 18:33:10 2026
 *   fax-number          : ...
 *   End send Fax        : ...
 *   Status : Failed. err = -1          ← 복합기가 자동 재다이얼하면 한 작업에 기록이 여러 개
 *   Start Fax           : Mon Oct 26 18:39:40 2026
 *   ...
 *   Status : Successfully.
 * - 판정은 이번 작업의 **마지막** 기록으로 한다 (재다이얼 끝에 성공하면 성공)
 * - 이번 작업의 기록 전체(실패한 시도 포함)를 결과에 담고, 드라이버 로그(/tmp, WSL 이 꺼지면 지워짐)는
 *   dataDir/epson-fax.log 에 작업별로 이어서 보관한다
 *
 * TXT 는 paps 로 PostScript 를 만들어 보낸다 (shell.ts txtToPs).
 * Windows 에이전트 + WSL 드라이버면 FAX_WSL_DISTRO 로 wsl.exe 를 거쳐 root 로 부른다.
 */
export class EpsonBackend implements FaxBackend {
  readonly name = 'epson';
  private readonly printer: string;
  private readonly logPath: string;
  private readonly dataDir: string;
  private readonly shell: Shell;

  constructor(printer: string, logPath: string, dataDir: string, wslDistro = '') {
    this.printer = printer;
    this.logPath = logPath;
    this.dataDir = dataDir;
    this.shell = new Shell(wslDistro, 'root');
  }

  async send({ jobId, filePath, faxNumber, progress = () => {} }: SendInput): Promise<SendResult> {
    const startedAt = Date.now();

    // 1. 복합기에 연결되는지 먼저 본다. 안 되면 리눅스를 한 번 다시 켜고(네트워크를 새로 만듦) 다시 본다
    const host = await this.printerHost();
    if (host) {
      progress(`복합기 연결 확인 (${host})`);
      if (!(await this.shell.canReach(host)) && this.shell.wslDistro) {
        progress('복합기에 연결되지 않아 게이트웨이의 리눅스(WSL)를 다시 켜는 중');
        await this.shell.restartLinux();
      }
      if (!(await this.shell.canReach(host))) {
        return {
          ok: false,
          detail: `게이트웨이가 복합기(${host})에 연결하지 못했어요. 복합기 전원과 네트워크를 확인하고, 계속되면 게이트웨이를 재시작해 주세요.`,
        };
      }
      progress('복합기 연결됨');
    }

    const logStart = await this.logSize();
    let file = this.shell.path(filePath);

    if (file.endsWith('.txt')) {
      const conv = await txtToPs(this.shell, file);
      if ('error' in conv) return { ok: false, detail: conv.error };
      file = conv.file;
    }
    const pages = await this.pageCount(file);
    const waitMin = Math.max(MIN_WAIT_MIN, 3 + 2 * (pages ?? 0));

    const submit = await this.shell.run('epfax2', ['-P', this.printer, '-o', `fax-number=${faxNumber}`, file]);
    if (submit.code !== 0) return { ok: false, detail: submit.output || `epfax2 종료 코드 ${submit.code}` };

    const requestId = /request id is (\S+)/.exec(submit.output)?.[1];
    if (!requestId) return { ok: false, detail: `대기열에 넣지 못했습니다: ${submit.output}`.slice(0, 500) };
    progress(`문서를 팩스용으로 바꿔 복합기로 넘기는 중${pages ? ` (${pages}장)` : ''}`);

    // 2. 대기열에서 빠질 때까지 (= 복합기가 재다이얼까지 포함해 전송을 끝낼 때까지)
    //    - 기다리는 동안 복합기 연결을 다시 확인한다. 두 번 연속 끊겨 있으면 멈춘 걸로 보고 취소
    //    - 드라이버 로그에 시도 결과가 생기면 알린다 (재다이얼)
    const deadline = Date.now() + waitMin * 60_000;
    let stop: 'timeout' | 'link' | null = null;
    let lastLinkCheck = Date.now();
    let linkFails = 0;
    let lastMinute = 0;
    // 드라이버 원문(Start Fax · fax-number · End send Fax · Status)을 시각과 한국어 문장으로 정리해 진행 단계로 알린다.
    // 원문은 서버로 보내지 않고 이 PC 의 epson-fax.log 에만 남긴다
    const emitted = new Set<string>();
    const timeline = (entries: string[], done: boolean) => {
      for (const ev of driverTimeline(entries, faxNumber, done)) {
        if (emitted.has(ev.key)) continue;
        emitted.add(ev.key);
        progress(ev.text, ev.at);
      }
    };
    while (await this.isQueued(requestId)) {
      if (Date.now() > deadline) stop = 'timeout';
      if (host && Date.now() - lastLinkCheck > LINK_CHECK_MS) {
        lastLinkCheck = Date.now();
        linkFails = (await this.shell.canReach(host)) ? 0 : linkFails + 1;
        if (linkFails >= 2) stop = 'link';
      }
      if (stop) {
        await this.shell.run('cancel', [requestId]);
        break;
      }
      timeline(jobEntries(await this.logSince(logStart), startedAt), false);
      const minute = Math.floor((Date.now() - startedAt) / 60_000);
      if (minute >= 2 && minute % 2 === 0 && minute !== lastMinute) {
        lastMinute = minute;
        progress(`복합기에서 보내는 중 (${minute}분째, 최대 ${waitMin}분)`);
      }
      await sleep(POLL_MS);
    }

    const entries = jobEntries(await this.logSince(logStart), startedAt);
    await this.keep(jobId, requestId, faxNumber, entries.join('\n'));
    timeline(entries, true);

    // 결과 문구만 돌려준다 (실패 이유). 진행은 위에서 알린 단계에 다 있다
    if (stop === 'link') return { ok: false, detail: `보내는 도중 복합기(${host})와 연결이 끊겨 취소했어요` };
    if (stop === 'timeout') return { ok: false, detail: `${waitMin}분 안에 전송이 끝나지 않아 취소했어요` };
    const status = statusOf(entries.at(-1) ?? '');
    if (status && /success/i.test(status)) return { ok: true };
    return { ok: false, detail: status ? `복합기가 보내지 못했어요 (${status})` : '전송 결과를 확인하지 못했어요' };
  }

  /** 드라이버 로그를 작업별로 영구 보관 (WSL 의 /tmp 는 꺼지면 지워짐) */
  private async keep(jobId: string, requestId: string, faxNumber: string, record: string): Promise<void> {
    try {
      await mkdir(this.dataDir, { recursive: true });
      const head = `=== ${new Date().toISOString()} job ${jobId} (${requestId}) → ${faxNumber}`;
      await appendFile(join(this.dataDir, 'epson-fax.log'), `${head}\n${record || '(드라이버 로그 없음)'}\n\n`);
    } catch {}
  }

  /** CUPS 장치 주소(epsonfax2://<복합기 IP>)에서 복합기 주소 */
  private async printerHost(): Promise<string | null> {
    const { output } = await this.shell.run('sh', ['-c', `LANG=C lpstat -v "${this.printer}" 2>/dev/null`]);
    return /:\/\/([^/:\s]+)/.exec(output)?.[1] ?? null;
  }

  /** 장수 (PDF 만. 모르면 null) */
  private async pageCount(file: string): Promise<number | null> {
    if (!/\.pdf$/i.test(file)) return null;
    const { output } = await this.shell.run('sh', ['-c', `pdfinfo "${file}" 2>/dev/null`]);
    return Number(/^Pages:\s+(\d+)/m.exec(output)?.[1]) || null;
  }

  private async isQueued(requestId: string): Promise<boolean> {
    const { output } = await this.shell.run('lpstat', ['-o', this.printer]);
    return output.split('\n').some((line) => line.startsWith(`${requestId} `));
  }

  private async logSize(): Promise<number> {
    // 로그가 없으면 0. 명령이 실패해서 0 이 되어도 jobEntries 가 시각으로 이번 작업 기록만 고른다
    const { code, output } = await this.shell.run('sh', ['-c', `wc -c < "${this.logPath}" 2>/dev/null || echo 0`]);
    return code === 0 ? Number(output.trim()) || 0 : 0;
  }

  private async logSince(offset: number): Promise<string> {
    const { output } = await this.shell.run('sh', ['-c', `tail -c +${offset + 1} "${this.logPath}" 2>/dev/null`]);
    return output.trim();
  }
}

/** 로그를 "Start Fax" 단위 기록으로 나눈다 */
export function splitEntries(log: string): string[] {
  return log
    .split(/(?=^\s*Start Fax\s*:)/m)
    .map((e) => e.trim())
    .filter((e) => /Start Fax\s*:/.test(e));
}

/** 이번 작업의 기록만: 작업을 넣은 시각(1분 여유) 이후에 시작한 기록. 시각을 못 읽으면 남긴다 */
export function jobEntries(log: string, startedAt: number): string[] {
  return splitEntries(log).filter((e) => {
    const t = Date.parse(/Start Fax\s*:\s*(.+)/.exec(e)?.[1]?.trim() ?? '');
    return Number.isNaN(t) || t >= startedAt - 60_000;
  });
}

/**
 * 드라이버 기록 → 시각 · 한국어 문장. 기록 하나 = 복합기가 번호를 건 한 번 (재다이얼이면 여러 개)
 *   번호(fax-number)가 적혀야 복합기까지 넘어간 것. done 인데 시작만 있으면 복합기로 못 넘어간 것
 */
export function driverTimeline(entries: string[], faxNumber: string, done: boolean): { key: string; text: string; at?: Date }[] {
  const first = timeOf(entries[0] ?? '', 'Start Fax');
  const out: { key: string; text: string; at?: Date }[] = [];
  entries.forEach((e, i) => {
    const number = /fax-number\s*:\s*(.+)/.exec(e)?.[1]?.trim();
    const st = statusOf(e);
    if (number || st || done) {
      const text = !number && !st ? '복합기로 넘기지 못함' : i === 0 ? `복합기가 ${number ?? faxNumber} 로 걸기 시작` : '복합기가 다시 걸기 시작';
      out.push({ key: `${i}s`, text, at: timeOf(e, 'Start Fax') });
    }
    if (st) {
      const end = timeOf(e, 'End send Fax');
      const took = first && end ? ` · ${duration(end.getTime() - first.getTime())} 걸림` : '';
      const text = /success/i.test(st) ? `전송 끝 — 성공${took}` : `걸었지만 실패 (${st.replace(/^Failed\.?\s*/i, '') || '복합기 응답 없음'})`;
      out.push({ key: `${i}e`, text, at: end });
    }
  });
  return out;
}

/** 기록 안의 시각 (예: Start Fax : Wed Oct 28 11:49:22 2026). 못 읽으면 undefined */
export function timeOf(entry: string, label: string): Date | undefined {
  const s = new RegExp(`${label}\\s*:\\s*(.+)`).exec(entry)?.[1]?.trim();
  const d = s ? new Date(Date.parse(s)) : undefined;
  return d && !Number.isNaN(d.getTime()) ? d : undefined;
}

/** 4분 10초 */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}분 ${s % 60}초` : `${s}초`;
}

export function statusOf(entry: string): string | undefined {
  return [...entry.matchAll(/Status\s*:\s*(.+)/gi)].pop()?.[1]?.trim();
}
