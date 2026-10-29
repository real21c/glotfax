import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import WebSocket from 'ws';
import { EpsonBackend } from './backends/epson.ts';
import { HpBackend } from './backends/hp.ts';
import { MockBackend } from './backends/mock.ts';
import type { FaxBackend } from './backends/types.ts';
import { loadConfig } from './config.ts';
import { type AvailableBackend, type BackendChoice, detectBackends, loadChoice, saveChoice } from './detect.ts';
import { Journal } from './journal.ts';

const VERSION = '1.0.0';
const PING_MS = 30_000;
const FAX_NUMBER_RE = /^[0-9][0-9,-]{2,40}$/;
const FILE_TYPES = ['pdf', 'txt', 'jpg', 'png'];

interface Job {
  id: string;
  attempt: number;
  faxNumber: string;
  fileName: string;
  fileType: string;
  fileSize: number;
}

const config = loadConfig();
const journal = new Journal(config.dataDir);
// 설정 화면에서 고른 값이 있으면 그걸, 없으면 환경 변수
let choice: BackendChoice = (await loadChoice(config.dataDir)) ?? {
  backend: config.backend,
  printer: config.backend === 'epson' ? config.epsonPrinter : config.backend === 'hp' ? config.hpPrinter : '',
};
let backend = createBackend(choice);
let available: AvailableBackend[] = [];
const queue: Job[] = [];
let ws: WebSocket | null = null;
let working = false;
let current: Job | null = null;
let retryDelay = 1000;

function createBackend(c: BackendChoice): FaxBackend {
  switch (c.backend) {
    case 'mock':
      return new MockBackend(config.mockDelayMs, config.mockSucceed);
    case 'epson':
      return new EpsonBackend(c.printer || config.epsonPrinter, config.epsonLog, config.dataDir, config.wslDistro);
    case 'hp':
      return new HpBackend(c.printer || config.hpPrinter, config.hpUser, config.wslDistro);
    default:
      console.error(`알 수 없는 백엔드: ${c.backend} (mock | epson | hp)`);
      process.exit(1);
  }
}

/** 지금 백엔드와 쓸 수 있는 목록을 서버에 알린다 (설정 화면에 표시) */
function backendState() {
  return { backend: choice.backend, printer: choice.printer, available };
}

/** 설정 화면의 '다시 확인': 드라이버 · 복합기를 다시 찾아 알린다 (설치 뒤 에이전트를 다시 켜지 않아도 되게) */
async function redetect() {
  const next = await detectBackends(config.wslDistro);
  // 리눅스 확인이 끝내 실패했는데 전에 쓸 수 있던 목록이 있으면, 멀쩡한 드라이버를 "쓸 수 없음"으로 바꾸지 않는다
  const failed = next.some((a) => a.reasonCode === 'no-linux');
  if (failed && available.some((a) => a.enabled && a.backend !== 'mock')) {
    log('드라이버 확인 실패 — 이전 목록 유지');
  } else {
    available = next;
  }
  ws?.send(JSON.stringify({ type: 'backend', ...backendState() }));
}

/** 설정 화면에서 고른 백엔드로 바꾼다. 보내는 중인 팩스는 바꾸기 전 백엔드로 끝난다 */
async function applyChoice(next: BackendChoice) {
  await redetect();
  const ok = available.find((a) => a.enabled && a.backend === next.backend && a.printer === next.printer);
  if (!ok) {
    ws?.send(JSON.stringify({ type: 'backend-error', message: '이 게이트웨이에서 쓸 수 없는 항목입니다', ...backendState() }));
    return;
  }
  choice = { backend: ok.backend, printer: ok.printer };
  backend = createBackend(choice);
  await saveChoice(config.dataDir, choice);
  log(`백엔드 변경: ${ok.label}`);
  ws?.send(JSON.stringify({ type: 'backend', ...backendState() }));
}

/** 진행 단계에 붙이는 시각 (게이트웨이의 시간, 예: 11:20:25) */
function clock(at?: Date): string {
  const d = at ?? new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function log(...args: unknown[]) {
  console.log(new Date().toISOString(), ...args);
}

// ------------------------------------------------------------ 연결

function connect() {
  const url = config.server.replace(/^http/, 'ws') + '/api/agent/connect';
  const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${config.token}` } });
  let ping: NodeJS.Timeout | undefined;

  socket.on('open', async () => {
    ws = socket;
    retryDelay = 1000;
    // 처음 켜질 때만 목록을 찾은 뒤 인사한다. 다시 연결될 때는 바로 인사하고(밀린 팩스가 늦지 않게) 목록은 뒤에서 다시 확인
    const first = available.length === 0;
    if (first) available = await detectBackends(config.wslDistro);
    log(`연결됨 (${backend.name}${choice.printer ? ` · ${choice.printer}` : ''})`);
    socket.send(JSON.stringify({ type: 'hello', version: VERSION, ...backendState(), recent: journal.recentFinal() }));
    ping = setInterval(() => socket.readyState === WebSocket.OPEN && socket.send('ping'), PING_MS);
    if (!first) void redetect();
  });

  socket.on('message', (data) => {
    const text = data.toString();
    if (text === 'pong') return;
    try {
      const msg = JSON.parse(text);
      if (msg.type === 'job' && msg.job?.id) enqueue({ ...msg.job, attempt: Number(msg.job.attempt) || 1 } as Job);
      if (msg.type === 'config' && typeof msg.backend === 'string') void applyChoice({ backend: msg.backend, printer: String(msg.printer ?? '') });
      if (msg.type === 'detect') void redetect();
    } catch {
      log('알 수 없는 메시지', text.slice(0, 200));
    }
  });

  socket.on('unexpected-response', (_req, res) => {
    log(`연결 거부 (${res.statusCode})${res.statusCode === 401 ? ' — 토큰을 확인하세요' : ''}`);
  });

  socket.on('error', (e) => log('연결 오류:', e.message));

  socket.on('close', (code) => {
    clearInterval(ping);
    if (ws === socket) ws = null;
    // 4000: 같은 토큰으로 다른 에이전트가 붙어서 밀려남. 서로 계속 밀어내지 않게 길게 쉰다
    const replaced = code === 4000;
    const delay = replaced ? 60_000 : Math.min(retryDelay, 30_000) + Math.floor(Math.random() * 1000);
    retryDelay = Math.min(retryDelay * 2, 30_000);
    if (replaced) log('같은 토큰으로 다른 에이전트가 연결되었습니다. 에이전트는 게이트웨이 하나에 하나만 실행하세요.');
    log(`연결 끊김 (${code}), ${Math.round(delay / 1000)}초 뒤 다시 연결`);
    setTimeout(connect, delay);
  });
}

function report(job: Job, status: 'sending' | 'sent' | 'failed', detail?: string) {
  // 끊겨 있으면 다음 연결 때 hello 의 recent 로 다시 알린다
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'status', jobId: job.id, attempt: job.attempt, status, detail }));
  }
}

const same = (a: Job | null, b: Job) => a?.id === b.id && a.attempt === b.attempt;

// ------------------------------------------------------------ 작업 처리 (한 번에 하나)

function enqueue(job: Job) {
  // 다시 연결할 때 서버가 밀린 작업을 또 보내므로, 처리 중이거나 대기 중인 건 무시
  if (same(current, job) || queue.some((j) => same(j, job))) return;
  queue.push(job);
  void work();
}

async function work() {
  if (working) return;
  working = true;
  try {
    while (queue.length) {
      const job = queue.shift()!;
      current = job;
      await handle(job);
      current = null;
    }
  } finally {
    working = false;
    current = null;
  }
}

async function handle(job: Job) {
  const prev = journal.get(job.id, job.attempt);
  if (prev?.status === 'sent' || prev?.status === 'failed') {
    report(job, prev.status, prev.detail);
    return;
  }
  if (prev?.status === 'sending') {
    // 보내던 중 에이전트가 꺼졌던 작업. 이미 나갔을 수 있어 자동으로 다시 보내지 않는다
    const detail = '전송 도중 에이전트가 중단되어 결과를 알 수 없습니다. 받는 쪽 확인 후 다시 보내 주세요.';
    await journal.set(job.id, job.attempt, 'failed', detail);
    report(job, 'failed', detail);
    return;
  }

  if (!FAX_NUMBER_RE.test(job.faxNumber)) {
    await journal.set(job.id, job.attempt, 'failed', '잘못된 팩스 번호');
    report(job, 'failed', '잘못된 팩스 번호');
    return;
  }

  log(`전송 시작 ${job.id}#${job.attempt} → ${job.faxNumber}`);
  await journal.set(job.id, job.attempt, 'sending');

  // 진행 단계: "보내는 중" 동안 서버에 쌓아 보낸 기록에서 보이게 한다
  const steps: string[] = [];
  const step = (text: string, at?: Date) => {
    steps.push(`${clock(at)}  ${text}`);
    report(job, 'sending', steps.join('\n'));
  };
  step('게이트웨이가 작업을 받음');

  const ext = FILE_TYPES.includes(job.fileType) ? job.fileType : 'pdf';
  const filePath = join(config.dataDir, 'jobs', `${job.id}.${ext}`);
  let status: 'sent' | 'failed';
  let detail: string | undefined;
  try {
    await download(job.id, filePath);
    step(`문서 받음 (${(job.fileSize / 1024 / 1024).toFixed(1)}MB)`);
    const result = await backend.send({ jobId: job.id, filePath, faxNumber: job.faxNumber, progress: step });
    status = result.ok ? 'sent' : 'failed';
    detail = result.detail;
  } catch (e) {
    status = 'failed';
    detail = e instanceof Error ? e.message : String(e);
  } finally {
    await rm(filePath, { force: true });
    await rm(`${filePath}.ps`, { force: true });
  }
  if (status === 'sent' && !steps.some((s) => s.includes('전송 끝'))) step('전송 끝 — 성공');
  if (status === 'failed') step(`보내지 못함 — ${(detail ?? '').split('\n')[0] || '이유를 알 수 없음'}`);

  // 저장하는 기록: 첫 줄은 실패 이유(실패일 때만), 그다음 "시각  내용" 줄들
  detail = [status === 'failed' ? (detail ?? '').split('\n')[0] : '', ...steps].filter(Boolean).join('\n');

  await journal.set(job.id, job.attempt, status, detail);
  report(job, status, detail);
  log(`전송 ${status === 'sent' ? '완료' : '실패'} ${job.id}#${job.attempt}${detail ? ` — ${detail}` : ''}`);
}

async function download(jobId: string, filePath: string) {
  const res = await fetch(`${config.server}/api/agent/jobs/${encodeURIComponent(jobId)}/file`, {
    headers: { Authorization: `Bearer ${config.token}` },
  });
  if (!res.ok) throw new Error(`파일을 받지 못했습니다 (${res.status})`);
  await mkdir(join(filePath, '..'), { recursive: true });
  const bytes = Buffer.from(await res.arrayBuffer());
  await writeFile(filePath, filePath.endsWith('.txt') ? toUtf8(bytes) : bytes);
}

/** TXT 는 드라이버(CUPS)가 UTF-8 로 읽는다. 윈도우 메모장의 한글(EUC-KR/CP949) 파일도 깨지지 않게 바꾼다 */
function toUtf8(bytes: Buffer): Buffer {
  const body = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  try {
    return Buffer.from(new TextDecoder('utf-8', { fatal: true }).decode(body), 'utf8');
  } catch {
    return Buffer.from(new TextDecoder('euc-kr').decode(body), 'utf8');
  }
}

// ------------------------------------------------------------ 시작

await journal.load();
log(`glotfax agent ${VERSION}, 서버 ${config.server}`);
connect();
