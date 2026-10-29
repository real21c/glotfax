import { Hono, type Context, type Next } from 'hono';
import { hashPassword, randomToken, safeEqual, sha256, verifyPassword } from './crypto';
import { GatewayHub } from './hub';
import { clearSessionCookie, createSessionCookie, readSession } from './session';
import type { AccessLogRow, AttemptRow, Env, GatewayRow, JobRow, TenantRow } from './types';

export { GatewayHub };

type Vars = { tenantId: string; gateway: GatewayRow };
type Ctx = Context<{ Bindings: Env; Variables: Vars }>;

// 지금은 tenant 하나. 계정이 붙으면 로그인 때 tenant 를 고른다
const DEFAULT_TENANT = 'default';

// 보낼 수 있는 파일: 내용(앞부분 바이트)으로 판별한다. 확장자만 믿지 않는다
const FILE_TYPES = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  txt: 'text/plain',
} as const;
type FileType = keyof typeof FILE_TYPES;

function detectFileType(name: string, bytes: ArrayBuffer): FileType | null {
  const b = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 65536));
  const starts = (...sig: number[]) => sig.every((v, i) => b[i] === v);
  if (starts(0x25, 0x50, 0x44, 0x46, 0x2d)) return 'pdf'; // %PDF-
  if (starts(0x89, 0x50, 0x4e, 0x47)) return 'png';
  if (starts(0xff, 0xd8, 0xff)) return 'jpg';
  // 텍스트: .txt 이고 NUL 바이트가 없을 때
  if (/.txt$/i.test(name) && !b.includes(0)) return 'txt';
  return null;
}

// 비밀번호 최소 길이 (기본 비밀번호 0000 을 쓸 수 있게 4)
const MIN_PASSWORD = 4;

// 숫자로 시작, 숫자·하이픈·쉼표(일시정지)만
const FAX_NUMBER_RE = /^[0-9][0-9,-]{2,40}$/;

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

const err = (c: Ctx, status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 426 | 429, message: string) =>
  c.json({ error: message }, status);

function hub(env: Env, gatewayId: string) {
  return env.GATEWAY_HUB.get(env.GATEWAY_HUB.idFromName(gatewayId));
}

function bearer(c: Ctx): string | null {
  const h = c.req.header('Authorization');
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 올린 PDF 를 열거나 다시 보낼 수 있는 기간. 지나면 파일이 남아 있어도 막는다 (정리는 매일 cron) */
function fileAvailable(env: Env, j: JobRow): boolean {
  return j.file_key !== null && j.created_at >= Date.now() - Number(env.RETENTION_DAYS ?? 3) * DAY_MS;
}

function jobView(env: Env, j: JobRow, attempts: AttemptRow[] = []) {
  const mine = attempts.filter((a) => a.job_id === j.id).sort((a, b) => a.attempt - b.attempt);
  return {
    attempt: j.attempt,
    // 보낸 일시: 마지막 시도를 시작한 시각 (아직 시작 전이면 없음 → 화면은 업로드 일시)
    sentAt: mine.at(-1)?.started_at ?? null,
    attempts: mine.map((a) => ({ attempt: a.attempt, status: a.status, detail: a.detail, startedAt: a.started_at, finishedAt: a.finished_at })),
    id: j.id,
    faxNumber: j.fax_number,
    fileName: j.file_name,
    fileSize: j.file_size,
    status: j.status,
    detail: j.detail,
    hasFile: fileAvailable(env, j),
    canRetry: j.status === 'failed' && fileAvailable(env, j),
    clientIp: j.client_ip,
    userAgent: j.user_agent,
    via: j.via,
    device: j.device,
    createdAt: j.created_at,
    updatedAt: j.updated_at,
  };
}

/** IP 이름표 (설정값 IP_LABELS). 잘못 적혀 있으면 빈 값 */
function ipLabels(env: Env): Record<string, string> {
  try {
    const v = JSON.parse(env.IP_LABELS ?? '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/** 요청한 곳: IP(Cloudflare 가 넣어 주는 값), 브라우저 정보, 설치한 앱(PWA)인지(화면이 알려 줌) */
function client(c: Ctx) {
  const via = c.req.header('X-Glotfax-Via');
  // 기기 모델 코드(예: SM-S918N). 글자 · 숫자 · 공백 · - _ . 만, 60자까지
  const device = c.req.header('X-Glotfax-Device')?.trim().slice(0, 60);
  return {
    ip: c.req.header('CF-Connecting-IP') ?? null,
    userAgent: c.req.header('User-Agent')?.slice(0, 500) ?? null,
    via: via === 'pwa' || via === 'browser' ? via : null,
    device: device && /^[\w .-]+$/.test(device) ? device : null,
  };
}

async function logAccess(c: Ctx, tenantId: string, event: AccessLogRow['event']): Promise<void> {
  const { ip, userAgent, via, device } = client(c);
  await c.env.DB.prepare('INSERT INTO access_logs (tenant_id, event, ip, user_agent, via, device, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(tenantId, event, ip, userAgent, via, device, Date.now())
    .run();
}

// ---------------------------------------------------------------- 보내는 사람

async function requireSession(c: Ctx, next: Next) {
  const session = await readSession(c.env.SESSION_SECRET, c.req.header('Cookie'));
  if (!session) return err(c, 401, '로그인이 필요합니다');
  // 비밀번호가 바뀌었으면 예전 로그인은 끊는다
  const tenant = await c.env.DB.prepare('SELECT session_version FROM tenants WHERE id = ?').bind(session.tenantId).first<{ session_version: number }>();
  if (!tenant || tenant.session_version !== session.version) {
    c.header('Set-Cookie', clearSessionCookie());
    return err(c, 401, '다시 로그인해 주세요');
  }
  c.set('tenantId', session.tenantId);
  await next();
}

// 로그인 시도 제한: 같은 곳(IP)에서 15분에 5번, 전체에서 1시간에 30번 틀리면 잠시 막는다.
// 막힌 동안은 맞는 비밀번호도 받지 않는다. 이미 로그인된 기기는 영향 없음
const LOGIN_LIMITS = [
  { perIp: true, max: 5, windowMs: 15 * 60 * 1000 },
  { perIp: false, max: 30, windowMs: 60 * 60 * 1000 },
];

/** 같은 곳으로 셀 IP 묶음. IPv6 는 한 사람이 /64 를 통째로 쓰므로 앞 4칸으로 묶는다 */
function ipGroup(ip: string | null): string {
  if (!ip?.includes(':')) return ip ?? '';
  return ip.split(':').slice(0, 4).join(':');
}

/** 막혀 있으면 풀릴 때까지 남은 시간(ms), 아니면 0 */
async function loginBlockedFor(c: Ctx, tenantId: string): Promise<number> {
  const now = Date.now();
  const longest = Math.max(...LOGIN_LIMITS.map((l) => l.windowMs));
  const { results } = await c.env.DB.prepare(
    `SELECT ip, created_at FROM access_logs WHERE tenant_id = ? AND event = 'login-failed' AND created_at >= ? ORDER BY created_at DESC LIMIT 500`,
  )
    .bind(tenantId, now - longest)
    .all<{ ip: string | null; created_at: number }>();
  const mine = ipGroup(client(c).ip);
  let wait = 0;
  for (const l of LOGIN_LIMITS) {
    const fails = results.filter((r) => r.created_at >= now - l.windowMs && (!l.perIp || ipGroup(r.ip) === mine));
    // 가장 최근 max 번째 실패가 창 밖으로 나가면 풀린다
    if (fails.length >= l.max) wait = Math.max(wait, fails[l.max - 1].created_at + l.windowMs - now);
  }
  return wait;
}

app.post('/api/login', async (c) => {
  const body = await c.req.json<{ password?: string }>().catch(() => ({}) as { password?: string });
  const tenant = await c.env.DB.prepare('SELECT * FROM tenants WHERE id = ?').bind(DEFAULT_TENANT).first<TenantRow>();
  const wait = tenant ? await loginBlockedFor(c, tenant.id) : 0;
  if (tenant && wait > 0) {
    await logAccess(c, tenant.id, 'login-blocked');
    const minutes = Math.ceil(wait / 60000);
    c.header('Retry-After', String(Math.ceil(wait / 1000)));
    return err(c, 429, `비밀번호를 여러 번 틀려서 잠시 막았어요. ${minutes}분 뒤에 다시 해 주세요`);
  }
  if (!tenant?.sender_password_hash || !body.password || !(await verifyPassword(body.password, tenant.sender_password_hash))) {
    if (tenant) await logAccess(c, tenant.id, 'login-failed');
    return err(c, 401, '비밀번호가 맞지 않습니다');
  }
  await logAccess(c, tenant.id, 'login');
  c.header('Set-Cookie', await createSessionCookie(c.env.SESSION_SECRET, tenant.id, tenant.session_version));
  return c.json({ ok: true });
});

/** 설정: 기본 받는 번호 (빈 값이면 지움) */
app.post('/api/settings', requireSession, async (c) => {
  const body = await c.req.json<{ defaultFaxNumber?: string }>().catch(() => ({}) as { defaultFaxNumber?: string });
  const number = String(body.defaultFaxNumber ?? '').replace(/\s/g, '');
  if (number && !FAX_NUMBER_RE.test(number)) return err(c, 400, '팩스 번호를 확인해 주세요');
  await c.env.DB.prepare('UPDATE tenants SET default_fax_number = ? WHERE id = ?').bind(number || null, c.get('tenantId')).run();
  return c.json({ ok: true, defaultFaxNumber: number || null });
});

/** 보내는 사람이 화면에서 비밀번호 바꾸기. 다른 기기는 로그아웃, 지금 기기는 새 쿠키로 유지 */
app.post('/api/password', requireSession, async (c) => {
  const body = await c.req.json<{ current?: string; next?: string }>().catch(() => ({}) as { current?: string; next?: string });
  const tenant = await c.env.DB.prepare('SELECT * FROM tenants WHERE id = ?').bind(c.get('tenantId')).first<TenantRow>();
  if (!tenant?.sender_password_hash || !body.current || !(await verifyPassword(body.current, tenant.sender_password_hash))) {
    return err(c, 400, '지금 비밀번호가 맞지 않습니다');
  }
  if (!body.next || body.next.length < MIN_PASSWORD) return err(c, 400, `새 비밀번호는 ${MIN_PASSWORD}자 이상이어야 합니다`);

  const updated = await c.env.DB.prepare(
    'UPDATE tenants SET sender_password_hash = ?, session_version = session_version + 1 WHERE id = ? RETURNING session_version',
  )
    .bind(await hashPassword(body.next), tenant.id)
    .first<{ session_version: number }>();
  c.header('Set-Cookie', await createSessionCookie(c.env.SESSION_SECRET, tenant.id, updated!.session_version));
  return c.json({ ok: true });
});

app.post('/api/logout', async (c) => {
  // 이미 끊긴 로그인(비밀번호 변경 · 모든 기기 로그아웃 뒤)은 기록하지 않는다
  const session = await readSession(c.env.SESSION_SECRET, c.req.header('Cookie'));
  const tenant = session
    ? await c.env.DB.prepare('SELECT session_version FROM tenants WHERE id = ?').bind(session.tenantId).first<{ session_version: number }>()
    : null;
  if (session && tenant?.session_version === session.version) await logAccess(c, session.tenantId, 'logout');
  c.header('Set-Cookie', clearSessionCookie());
  return c.json({ ok: true });
});

/** 모든 기기에서 로그아웃 (이 기기 포함). 세션 번호를 올려 예전 쿠키를 모두 무효로 만든다 */
app.post('/api/logout-all', requireSession, async (c) => {
  const tenantId = c.get('tenantId');
  await c.env.DB.prepare('UPDATE tenants SET session_version = session_version + 1 WHERE id = ?').bind(tenantId).run();
  await logAccess(c, tenantId, 'logout-all');
  c.header('Set-Cookie', clearSessionCookie());
  return c.json({ ok: true });
});

/** 설정: 로그인 기록 (최근 것부터) */
app.get('/api/access-logs', requireSession, async (c) => {
  const limit = Math.min(Number(c.req.query('limit') ?? 30) || 30, 100);
  const { results } = await c.env.DB.prepare('SELECT * FROM access_logs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?')
    .bind(c.get('tenantId'), limit)
    .all<AccessLogRow>();
  return c.json({
    logs: results.map((l) => ({ event: l.event, ip: l.ip, userAgent: l.user_agent, via: l.via, device: l.device, createdAt: l.created_at })),
  });
});

app.get('/api/me', requireSession, async (c) => {
  const tenantId = c.get('tenantId');
  const tenant = await c.env.DB.prepare('SELECT id, name, default_fax_number FROM tenants WHERE id = ?').bind(tenantId).first<TenantRow>();
  const { results } = await c.env.DB.prepare('SELECT * FROM gateways WHERE tenant_id = ? ORDER BY created_at')
    .bind(tenantId)
    .all<GatewayRow>();
  const gateways = await Promise.all(
    results.map(async (g) => ({ id: g.id, name: g.name, ...(await hub(c.env, g.id).info()), lastSeenAt: g.last_seen_at })),
  );
  // 마지막으로 보낸 번호(성공한 것 우선). 어느 기기에서 열어도 받는 번호 칸에 미리 채운다
  const last = await c.env.DB.prepare(
    `SELECT fax_number FROM jobs WHERE tenant_id = ? ORDER BY (status = 'sent') DESC, created_at DESC LIMIT 1`,
  )
    .bind(tenantId)
    .first<{ fax_number: string }>();
  return c.json({
    tenant: { id: tenant?.id, name: tenant?.name },
    gateways,
    lastFaxNumber: last?.fax_number ?? null,
    defaultFaxNumber: tenant?.default_fax_number ?? null,
    maxFileMb: Number(c.env.MAX_FILE_MB ?? 10),
    ipLabels: ipLabels(c.env),
  });
});

app.get('/api/jobs', requireSession, async (c) => {
  const limit = Math.min(Number(c.req.query('limit') ?? 20) || 20, 100);
  const { results } = await c.env.DB.prepare('SELECT * FROM jobs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?')
    .bind(c.get('tenantId'), limit)
    .all<JobRow>();
  const attempts = results.length
    ? (
        await c.env.DB.prepare(`SELECT * FROM job_attempts WHERE job_id IN (${results.map(() => '?').join(',')})`)
          .bind(...results.map((j) => j.id))
          .all<AttemptRow>()
      ).results
    : [];
  return c.json({ jobs: results.map((j) => jobView(c.env, j, attempts)) });
});

/** 통계: 날짜별(한국 시간) 보낸 건수. 보낸 날만 내려간다 */
app.get('/api/jobs/daily', requireSession, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT date(created_at / 1000, 'unixepoch', '+9 hours') AS day,
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM jobs WHERE tenant_id = ?
      GROUP BY day ORDER BY day DESC LIMIT 60`,
  )
    .bind(c.get('tenantId'))
    .all<{ day: string; total: number; sent: number | null; failed: number | null }>();
  return c.json({ days: results.map((r) => ({ day: r.day, total: r.total, sent: r.sent ?? 0, failed: r.failed ?? 0 })) });
});

app.post('/api/jobs', requireSession, async (c) => {
  const tenantId = c.get('tenantId');
  const form = await c.req.formData().catch(() => null);
  const file = form?.get('file');
  const faxNumber = String(form?.get('faxNumber') ?? '').replace(/\s/g, '');
  const gatewayId = String(form?.get('gatewayId') ?? '');

  if (!(file instanceof File) || file.size === 0) return err(c, 400, '보낼 파일을 선택해 주세요');
  if (!FAX_NUMBER_RE.test(faxNumber)) return err(c, 400, '팩스 번호를 확인해 주세요');

  const maxBytes = Number(c.env.MAX_FILE_MB ?? 10) * 1024 * 1024;
  if (file.size > maxBytes) return err(c, 413, `파일은 ${c.env.MAX_FILE_MB ?? 10}MB 까지 보낼 수 있습니다`);

  const bytes = await file.arrayBuffer();
  const type = detectFileType(file.name, bytes);
  if (!type) return err(c, 415, 'PDF, TXT, JPG, PNG 파일만 보낼 수 있습니다');

  const gateway = gatewayId
    ? await c.env.DB.prepare('SELECT * FROM gateways WHERE id = ? AND tenant_id = ?').bind(gatewayId, tenantId).first<GatewayRow>()
    : await c.env.DB.prepare('SELECT * FROM gateways WHERE tenant_id = ? ORDER BY created_at LIMIT 1').bind(tenantId).first<GatewayRow>();
  if (!gateway) return err(c, 409, '등록된 게이트웨이가 없습니다');

  const id = crypto.randomUUID();
  const fileKey = `${tenantId}/${id}.${type}`;
  const now = Date.now();
  const { ip, userAgent, via, device } = client(c);
  await c.env.FILES.put(fileKey, bytes, { httpMetadata: { contentType: FILE_TYPES[type] } });

  const job = await c.env.DB.prepare(
    `INSERT INTO jobs (id, tenant_id, gateway_id, fax_number, file_key, file_name, file_size, status, client_ip, user_agent, via, device, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?) RETURNING *`,
  )
    .bind(id, tenantId, gateway.id, faxNumber, fileKey, file.name.slice(0, 200) || `document.${type}`, file.size, ip, userAgent, via, device, now, now)
    .first<JobRow>();

  await hub(c.env, gateway.id).dispatch(job!);
  const fresh = await c.env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first<JobRow>();
  return c.json({ job: jobView(c.env, fresh!) }, 201);
});

/** 보낸 기록에서 올린 PDF 열기 (보관 기간 안에서만) */
app.get('/api/jobs/:id/file', requireSession, async (c) => {
  const job = await c.env.DB.prepare('SELECT * FROM jobs WHERE id = ? AND tenant_id = ?')
    .bind(c.req.param('id'), c.get('tenantId'))
    .first<JobRow>();
  if (!job || !fileAvailable(c.env, job)) return err(c, 404, '보관 기간이 지나 파일을 열 수 없습니다');
  const obj = await c.env.FILES.get(job.file_key!);
  if (!obj) return err(c, 404, '보관 기간이 지나 파일을 열 수 없습니다');
  // TXT 는 인코딩을 모르니 브라우저가 판단하게 charset 을 붙이지 않는다
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Content-Length': String(obj.size),
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(job.file_name)}`,
      'Cache-Control': 'private, no-store',
    },
  });
});

/** 설정: 게이트웨이가 쓸 백엔드(Epson · HP · 테스트) 바꾸기 */
app.post('/api/gateways/:id/backend', requireSession, async (c) => {
  const body = await c.req.json<{ backend?: string; printer?: string }>().catch(() => ({}) as { backend?: string; printer?: string });
  const gateway = await c.env.DB.prepare('SELECT id FROM gateways WHERE id = ? AND tenant_id = ?')
    .bind(c.req.param('id'), c.get('tenantId'))
    .first<{ id: string }>();
  if (!gateway) return err(c, 404, '게이트웨이를 찾을 수 없습니다');
  if (!body.backend) return err(c, 400, '백엔드를 골라 주세요');
  const result = await hub(c.env, gateway.id).setBackend({ backend: body.backend, printer: String(body.printer ?? '') });
  if (!result.ok) return err(c, 409, result.error ?? '바꾸지 못했습니다');
  return c.json({ ok: true });
});

/** 설정: 게이트웨이의 드라이버 · 복합기 다시 확인 */
app.post('/api/gateways/:id/detect', requireSession, async (c) => {
  const gateway = await c.env.DB.prepare('SELECT id FROM gateways WHERE id = ? AND tenant_id = ?')
    .bind(c.req.param('id'), c.get('tenantId'))
    .first<{ id: string }>();
  if (!gateway) return err(c, 404, '게이트웨이를 찾을 수 없습니다');
  if (!(await hub(c.env, gateway.id).redetect())) return err(c, 409, '게이트웨이가 꺼져 있습니다');
  return c.json({ ok: true });
});

app.post('/api/jobs/:id/retry', requireSession, async (c) => {
  const job = await c.env.DB.prepare(
    `UPDATE jobs SET status = 'queued', detail = NULL, attempt = attempt + 1, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND status = 'failed' AND file_key IS NOT NULL AND created_at >= ?
      RETURNING *`,
  )
    .bind(Date.now(), c.req.param('id'), c.get('tenantId'), Date.now() - Number(c.env.RETENTION_DAYS ?? 3) * DAY_MS)
    .first<JobRow>();
  if (!job) return err(c, 404, '다시 보낼 수 없는 작업입니다');

  await hub(c.env, job.gateway_id).dispatch(job);
  const fresh = await c.env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(job.id).first<JobRow>();
  return c.json({ job: jobView(c.env, fresh!) });
});

// 푸터 숫자 줄 (TODAY · TOTAL · 전송 건수). 건수만 내보낸다
app.get('/api/stats', async (c) => {
  const KST = 9 * 60 * 60 * 1000;
  const now = Date.now();
  const todayStart = now - ((now + KST) % (24 * 60 * 60 * 1000));
  const row = await c.env.DB.prepare(
    `SELECT
       SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS today,
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent
     FROM jobs`,
  )
    .bind(todayStart)
    .first<{ today: number | null; total: number; sent: number | null }>();
  c.header('Cache-Control', 'public, max-age=60');
  return c.json({ today: row?.today ?? 0, total: row?.total ?? 0, sent: row?.sent ?? 0 });
});

// 서비스 워커가 아직 없을 때 공유 메뉴로 들어온 경우
app.post('/share', (c) => c.redirect('/?share=retry', 303));

// ---------------------------------------------------------------- 에이전트

async function requireGateway(c: Ctx, next: Next) {
  const token = bearer(c);
  if (!token) return err(c, 401, 'missing token');
  const gateway = await c.env.DB.prepare('SELECT * FROM gateways WHERE token_hash = ?').bind(await sha256(token)).first<GatewayRow>();
  if (!gateway) return err(c, 401, 'invalid token');
  c.set('gateway', gateway);
  await next();
}

app.get('/api/agent/connect', requireGateway, async (c) => {
  if (c.req.header('Upgrade') !== 'websocket') return err(c, 426, 'expected websocket');
  const req = new Request(c.req.raw);
  req.headers.set('X-Glotfax-Gateway', c.get('gateway').id);
  return hub(c.env, c.get('gateway').id).fetch(req);
});

app.get('/api/agent/jobs/:id/file', requireGateway, async (c) => {
  const job = await c.env.DB.prepare('SELECT * FROM jobs WHERE id = ? AND gateway_id = ?')
    .bind(c.req.param('id'), c.get('gateway').id)
    .first<JobRow>();
  if (!job?.file_key) return err(c, 404, 'file not found');
  const obj = await c.env.FILES.get(job.file_key);
  if (!obj) return err(c, 404, 'file not found');
  return new Response(obj.body, {
    headers: { 'Content-Type': obj.httpMetadata?.contentType ?? 'application/octet-stream', 'Content-Length': String(obj.size) },
  });
});

// ---------------------------------------------------------------- 관리 (ADMIN_TOKEN)

async function requireAdmin(c: Ctx, next: Next) {
  const token = bearer(c);
  if (!token || !c.env.ADMIN_TOKEN || !(await safeEqual(token, c.env.ADMIN_TOKEN))) return err(c, 401, 'unauthorized');
  await next();
}

async function ensureTenant(env: Env, name?: string): Promise<void> {
  await env.DB.prepare('INSERT OR IGNORE INTO tenants (id, name, created_at) VALUES (?, ?, ?)')
    .bind(DEFAULT_TENANT, name || 'glotfax', Date.now())
    .run();
}

/** 보내는 사람 비밀번호 설정 */
app.post('/api/admin/password', requireAdmin, async (c) => {
  const { password } = await c.req.json<{ password?: string }>().catch(() => ({}) as { password?: string });
  if (!password || password.length < MIN_PASSWORD) return err(c, 400, `password must be at least ${MIN_PASSWORD} characters`);
  await ensureTenant(c.env);
  // 관리자가 바꿔도 모든 기기를 로그아웃시킨다
  await c.env.DB.prepare('UPDATE tenants SET sender_password_hash = ?, session_version = session_version + 1 WHERE id = ?')
    .bind(await hashPassword(password), DEFAULT_TENANT)
    .run();
  return c.json({ ok: true });
});

/** 게이트웨이 등록. 토큰은 이때 한 번만 보여 준다 */
app.post('/api/admin/gateways', requireAdmin, async (c) => {
  const { name } = await c.req.json<{ name?: string }>().catch(() => ({}) as { name?: string });
  await ensureTenant(c.env);
  const id = crypto.randomUUID();
  const token = randomToken('gfg_');
  await c.env.DB.prepare('INSERT INTO gateways (id, tenant_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, DEFAULT_TENANT, (name || 'fax-pc').slice(0, 100), await sha256(token), Date.now())
    .run();
  return c.json({ id, token }, 201);
});

app.all('/api/*', (c) => err(c, 404, 'not found'));

// ---------------------------------------------------------------- 보관 기간 지난 PDF 정리

async function cleanup(env: Env): Promise<void> {
  const cutoff = Date.now() - Number(env.RETENTION_DAYS ?? 3) * DAY_MS;
  const { results } = await env.DB.prepare('SELECT id, file_key FROM jobs WHERE file_key IS NOT NULL AND created_at < ? LIMIT 500')
    .bind(cutoff)
    .all<{ id: string; file_key: string }>();
  if (!results.length) return;
  await env.FILES.delete(results.map((r) => r.file_key));
  await env.DB.batch(results.map((r) => env.DB.prepare('UPDATE jobs SET file_key = NULL WHERE id = ?').bind(r.id)));
}

export default {
  fetch: app.fetch,
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(cleanup(env));
  },
} satisfies ExportedHandler<Env>;
