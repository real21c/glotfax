import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Shell } from './backends/shell.ts';

/** 어떤 백엔드로, 어느 CUPS 팩스 대기열로 보낼지 */
export interface BackendChoice {
  backend: string;
  printer: string;
}

export interface AvailableBackend extends BackendChoice {
  label: string;
  /** false 면 설정 화면에서 골랐을 때 안내만 하고 적용하지 않는다 */
  enabled: boolean;
  /** 쓸 수 없는 이유: no-linux(리눅스·WSL 확인 실패 — 없거나 답이 없음) | no-driver(드라이버 없음) | no-printer(등록된 복합기 없음) */
  reasonCode?: 'no-linux' | 'no-driver' | 'no-printer';
  reason?: string;
}

/** 드라이버 확인: 최대 3번, 5초 간격, 한 번에 1분까지 기다림 (꺼진 WSL 이 켜지는 데 몇 초 걸린다) */
const DETECT_TRIES = 3;
const DETECT_RETRY_MS = 5000;
const DETECT_TIMEOUT_MS = 60_000;

const MOCK: AvailableBackend ={ backend: 'mock', printer: '', label: '테스트 (실제로 안 보냄)', enabled: true };

/** 지원하는 제조사. 쓸 수 없어도 설정 화면에 이유와 함께 보여 준다 */
const VENDORS = [
  { backend: 'epson', name: 'Epson', uri: 'epsonfax2://', driver: 'Epson 팩스 드라이버(PC-Fax 2)', register: 'lpadmin 으로 epsonfax2:// 등록' },
  { backend: 'hp', name: 'HP', uri: 'hpfax:', driver: 'HP 팩스 드라이버(HPLIP)', register: 'hp-setup 으로 등록' },
] as const;

/**
 * 이 게이트웨이의 백엔드 목록. 지원하는 제조사는 전부 넣고, 쓸 수 없으면 이유를 붙인다.
 * - 쓸 수 있음: 드라이버(epfax2 · hp-sendfax)가 있고, CUPS 에 그 제조사 팩스 대기열이 있을 때 (대기열마다 하나)
 * - 쓸 수 없음: 드라이버가 없거나, 드라이버는 있는데 등록된 팩스(대기열)가 없을 때
 * - 테스트(mock): 항상
 */
export async function detectBackends(wslDistro: string): Promise<AvailableBackend[]> {
  const shell = new Shell(wslDistro, 'root');
  // WSL 은 쉬면 스스로 꺼지고, 꺼지거나 켜지는 순간에는 명령이 실패할 수 있다.
  // 한 번 실패로 "쓸 수 없음"을 띄우지 않게 몇 초 간격으로 다시 확인하고, 끝내 실패하면 이유를 로그에 남긴다
  let code = -1;
  let output = '';
  for (let attempt = 1; attempt <= DETECT_TRIES; attempt++) {
    ({ code, output } = await shell.run(
      'sh',
      ['-c', 'echo "epfax2=$(command -v epfax2)"; echo "hpsendfax=$(command -v hp-sendfax)"; LANG=C lpstat -v 2>/dev/null'],
      DETECT_TIMEOUT_MS,
    ));
    if (code === 0) break;
    console.log(new Date().toISOString(), `드라이버 확인 실패 (${attempt}/${DETECT_TRIES}, 종료 코드 ${code}): ${output.trim().slice(0, 300)}`);
    if (attempt < DETECT_TRIES) await new Promise((r) => setTimeout(r, DETECT_RETRY_MS));
  }
  const ran = code === 0;
  const hasDriver: Record<string, boolean> = {
    epson: ran && /^epfax2=\S+/m.test(output),
    hp: ran && /^hpsendfax=\S+/m.test(output),
  };
  const queues = ran ? [...output.matchAll(/^device for (\S+?):\s*(\S+)/gm)].map((m) => ({ printer: m[1], uri: m[2] })) : [];

  const list: AvailableBackend[] = [];
  for (const v of VENDORS) {
    const mine = queues.filter((q) => q.uri.startsWith(v.uri));
    if (hasDriver[v.backend] && mine.length) {
      for (const q of mine) list.push({ backend: v.backend, printer: q.printer, label: `${v.name} · ${q.printer}`, enabled: true });
      continue;
    }
    const reasonCode = !ran ? 'no-linux' : !hasDriver[v.backend] ? 'no-driver' : 'no-printer';
    const reason = {
      'no-linux': '게이트웨이의 리눅스(WSL)에서 드라이버를 확인하지 못했어요',
      'no-driver': `${v.driver}가 설치돼 있지 않아요`,
      'no-printer': `등록된 ${v.name} 팩스가 없어요 (${v.register})`,
    }[reasonCode];
    list.push({ backend: v.backend, printer: '', label: v.name, enabled: false, reasonCode, reason });
  }
  return [...list, MOCK];
}

/** 설정 화면에서 고른 값. 에이전트를 다시 켜도 유지된다 (환경 변수보다 우선) */
export async function loadChoice(dataDir: string): Promise<BackendChoice | null> {
  try {
    const c = JSON.parse(await readFile(join(dataDir, 'backend.json'), 'utf8'));
    return typeof c.backend === 'string' ? { backend: c.backend, printer: String(c.printer ?? '') } : null;
  } catch {
    return null;
  }
}

export async function saveChoice(dataDir: string, choice: BackendChoice): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, 'backend.json'), JSON.stringify(choice));
}
