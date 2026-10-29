import { Shell, stripAnsi, txtToPs } from './shell.ts';
import type { FaxBackend, SendInput, SendResult } from './types.ts';

const TIMEOUT_MS = 15 * 60 * 1000;

/**
 * HP (HPLIP) 팩스. hp-sendfax 를 창 없는 모드로 부른다.
 *   hp-sendfax -n -p <CUPS 팩스 대기열> -f <번호> <파일>
 * 필요한 패키지: hplip, hplip-gui (hp-sendfax 가 들어 있음). 대기열은 hp-setup 이나
 *   lpadmin -p HP_FAX -v 'hpfax:/net/<모델>?ip=<복합기 IP>' -P <HP-Fax*.ppd> 로 만든다.
 *
 * - root 로는 실행되지 않는다 → 일반 사용자(HP_USER, lp·lpadmin 그룹)로 실행
 * - 실패해도 종료 코드가 0 이라 출력의 error: · "Fax send error" 로 판정한다
 *   (실제 HP 복합기로는 아직 확인 안 함 — 오류 문구가 없으면 성공으로 본다)
 * - 실행할 때 hp-systray 가 같이 떠서, 끝나면 정리한다
 * - 실패하면 대기열에 작업이 남아서 비운다
 */
export class HpBackend implements FaxBackend {
  readonly name = 'hp';
  private readonly printer: string;
  private readonly shell: Shell;

  constructor(printer: string, user: string, wslDistro = '') {
    this.printer = printer;
    this.shell = new Shell(wslDistro, user);
  }

  async send({ filePath, faxNumber }: SendInput): Promise<SendResult> {
    let file = this.shell.path(filePath);
    if (file.endsWith('.txt')) {
      const conv = await txtToPs(this.shell, file);
      if ('error' in conv) return { ok: false, detail: conv.error };
      file = conv.file;
    }

    try {
      const { code, output } = await this.shell.run('hp-sendfax', ['-n', '-p', this.printer, '-f', faxNumber, file], TIMEOUT_MS);
      const lines = stripAnsi(output)
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !/copyright|warranty|free software|certain conditions|linux imaging/i.test(l));
      const errors = lines.filter((l) => /^error:|fax send error|aborting/i.test(l));
      const detail = (errors.length ? errors : lines.slice(-6)).join('\n').slice(-500);

      if (code !== 0 || errors.length) {
        // 실패하면 CUPS 팩스 대기열에 작업이 남는다 → 비운다 (에이전트는 한 번에 한 통만 보내서 다른 작업은 없음)
        await this.shell.run('cancel', ['-a', '-x', this.printer]);
        return { ok: false, detail: detail || `hp-sendfax 종료 코드 ${code}` };
      }
      return { ok: true, detail };
    } finally {
      await this.shell.run('pkill', ['-u', this.shell.user, '-f', 'hp-systray']);
    }
  }
}
