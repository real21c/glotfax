import { spawn } from 'node:child_process';

/** 리눅스 명령을 바로, 또는 Windows 에서 WSL 을 거쳐 실행한다 */
export class Shell {
  /** Windows 에이전트 + WSL 드라이버일 때 배포판 이름. 비어 있으면 리눅스에서 바로 실행 */
  readonly wslDistro: string;
  /** WSL 안에서 실행할 사용자 (root 로 못 도는 드라이버가 있음) */
  readonly user: string;

  constructor(wslDistro: string, user = 'root') {
    this.wslDistro = wslDistro;
    this.user = user;
  }

  run(cmd: string, args: string[], timeoutMs = 0): Promise<{ code: number; output: string }> {
    return this.wslDistro
      ? run('wsl.exe', ['-d', this.wslDistro, '-u', this.user, '--', cmd, ...args], timeoutMs)
      : run(cmd, args, timeoutMs);
  }

  /** WSL 배포판을 끈다 (다음 명령 때 새로 켜지면서 네트워크도 다시 만들어진다). 리눅스에서 바로 돌면 아무것도 안 함 */
  async restartLinux(): Promise<void> {
    if (this.wslDistro) await run('wsl.exe', ['--terminate', this.wslDistro], 60_000);
  }

  /**
   * 복합기에 연결되는지: ping, 안 되면 웹 설정 포트(80 · 443). 복합기가 ping 을 막아 두었을 수 있어 둘 다 본다.
   * host 는 CUPS 장치 주소에서 꺼낸 IP · 이름이라 따옴표 없이 넘겨도 되는 글자만 허용한다
   */
  async canReach(host: string): Promise<boolean> {
    if (!/^[A-Za-z0-9.:-]+$/.test(host)) return false;
    const { code } = await this.run(
      'bash',
      ['-c', `ping -c 1 -W 2 ${host} >/dev/null 2>&1 || timeout 3 bash -c 'echo > /dev/tcp/${host}/80' 2>/dev/null || timeout 3 bash -c 'echo > /dev/tcp/${host}/443' 2>/dev/null`],
      60_000,
    );
    return code === 0;
  }

  /** 에이전트 쪽 경로 → 드라이버 쪽 경로 (WSL 이면 D:\x.pdf → /mnt/d/x.pdf) */
  path(p: string): string {
    return this.wslDistro ? toWslPath(p) : p;
  }
}

/** D:\dev\x.pdf → /mnt/d/dev/x.pdf */
export function toWslPath(p: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}` : p.replace(/\\/g, '/');
}

export const TXT_FONT = 'NanumGothicCoding 12';

/**
 * TXT → PostScript. CUPS 기본 변환기(texttopdf)는 한글을 못 그려서 paps 로 만든다.
 * 필요한 패키지: paps, fonts-nanum-coding. 경로는 에이전트가 정한 것(작업 ID)이라 따옴표로 감싸 셸에 넘긴다.
 */
export async function txtToPs(shell: Shell, file: string): Promise<{ file: string } | { error: string }> {
  const ps = `${file}.ps`;
  const conv = await shell.run('sh', ['-c', `paps --paper=A4 --font="${TXT_FONT}" "${file}" > "${ps}"`]);
  if (conv.code !== 0) return { error: `TXT 를 변환하지 못했습니다: ${conv.output}`.slice(0, 500) };
  return { file: ps };
}

/** 색 코드 등 터미널 제어 문자 제거 */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    // 셸을 거치지 않는다 (번호·경로가 그대로 인자로 들어감)
    // windowsHide: 창 없이 돌 때 wsl.exe 를 부를 때마다 명령 창이 깜빡이지 않게
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, WSL_UTF8: '1' } });
    let output = '';
    let timer: NodeJS.Timeout | undefined;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        output += `\n${timeoutMs / 60000}분 안에 끝나지 않아 중단했습니다`;
        child.kill();
      }, timeoutMs);
    }
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('error', (e) => resolve({ code: -1, output: `${cmd} 실행 실패: ${e.message}` }));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, output: output.trim() });
    });
  });
}
