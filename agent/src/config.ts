import { resolve } from 'node:path';

export interface Config {
  server: string;
  token: string;
  backend: string;
  dataDir: string;
  mockDelayMs: number;
  mockSucceed: boolean;
  epsonPrinter: string;
  epsonLog: string;
  /** Windows 에이전트 + WSL 드라이버일 때 배포판 이름 (리눅스에서 돌면 비움) */
  wslDistro: string;
  hpPrinter: string;
  hpUser: string;
}

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`환경 변수 ${name} 가 없습니다. .env.example 을 참고하세요.`);
    process.exit(1);
  }
  return v;
}

export function loadConfig(): Config {
  return {
    server: required('GLOTFAX_SERVER').replace(/\/+$/, ''),
    token: required('GLOTFAX_TOKEN'),
    backend: process.env.GLOTFAX_BACKEND?.trim() || 'mock',
    dataDir: resolve(process.env.GLOTFAX_DATA_DIR?.trim() || './data'),
    mockDelayMs: Number(process.env.MOCK_DELAY_MS ?? 3000),
    mockSucceed: (process.env.MOCK_RESULT?.trim() || 'sent') !== 'failed',
    epsonPrinter: process.env.EPSON_PRINTER?.trim() || 'EPSON_FAX2',
    epsonLog: process.env.EPSON_LOG?.trim() || '/tmp/epsonfax2-log.txt',
    // EPSON_WSL_DISTRO 는 예전 이름 (호환)
    wslDistro: (process.env.FAX_WSL_DISTRO ?? process.env.EPSON_WSL_DISTRO ?? '').trim(),
    hpPrinter: process.env.HP_PRINTER?.trim() || 'HP_FAX',
    hpUser: process.env.HP_USER?.trim() || 'glotfax',
  };
}
