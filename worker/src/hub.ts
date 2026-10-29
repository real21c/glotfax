import { DurableObject } from 'cloudflare:workers';
import { type AgentMessage, type AvailableBackend, type BackendState, type Env, type JobRow, toJobMessage } from './types';

interface Attachment {
  gatewayId: string;
}

/**
 * 게이트웨이 하나당 하나. 에이전트의 WebSocket 을 들고 있다가
 * 새 작업을 바로 넘기고, 에이전트가 보내는 상태를 D1 에 기록한다.
 * Hibernation API 를 써서 연결만 유지하는 동안은 깨어 있지 않는다.
 */
export class GatewayHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // 에이전트의 연결 유지용 ping 은 DO 를 깨우지 않고 응답
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  /** Worker 가 에이전트 인증을 끝낸 뒤 X-Glotfax-Gateway 헤더를 붙여 넘긴다 */
  async fetch(request: Request): Promise<Response> {
    const gatewayId = request.headers.get('X-Glotfax-Gateway');
    if (!gatewayId || request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }

    // 게이트웨이당 에이전트는 하나. 이전 연결은 닫는다
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(4000, 'replaced by new connection');
      } catch {}
    }

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ gatewayId } satisfies Attachment);

    await this.env.DB.prepare('UPDATE gateways SET last_seen_at = ? WHERE id = ?').bind(Date.now(), gatewayId).run();
    return new Response(null, { status: 101, webSocket: client });
  }

  async isOnline(): Promise<boolean> {
    return this.ctx.getWebSockets().length > 0;
  }

  /** 연결 여부, 지금 백엔드(mock 이면 화면에 테스트 모드), 고를 수 있는 백엔드 목록 */
  async info(): Promise<{ online: boolean; backend: string | null; printer: string | null; available: AvailableBackend[]; backendError: string | null }> {
    const online = this.ctx.getWebSockets().length > 0;
    const s = (await this.ctx.storage.get<BackendState & { error?: string }>('backendState')) ?? null;
    return {
      online,
      backend: online ? (s?.backend ?? null) : null,
      printer: online ? (s?.printer ?? null) : null,
      available: online ? (s?.available ?? []) : [],
      backendError: s?.error ?? null,
    };
  }

  /** 설정 화면에서 고른 백엔드를 에이전트에 보낸다. 결과는 에이전트가 'backend' 로 알려 줌 */
  async setBackend(choice: { backend: string; printer: string }): Promise<{ ok: boolean; error?: string }> {
    const ws = this.ctx.getWebSockets()[0];
    if (!ws) return { ok: false, error: '게이트웨이가 꺼져 있습니다' };
    const s = await this.ctx.storage.get<BackendState>('backendState');
    if (!s?.available?.some((a) => a.enabled !== false && a.backend === choice.backend && a.printer === choice.printer)) {
      return { ok: false, error: '이 게이트웨이에서 쓸 수 없는 항목입니다' };
    }
    ws.send(JSON.stringify({ type: 'config', ...choice }));
    return { ok: true };
  }

  /** 에이전트에게 드라이버 · 복합기를 다시 찾게 한다 */
  async redetect(): Promise<boolean> {
    const ws = this.ctx.getWebSockets()[0];
    if (!ws) return false;
    ws.send(JSON.stringify({ type: 'detect' }));
    return true;
  }

  private async saveBackendState(msg: BackendState, error?: string): Promise<void> {
    await this.ctx.storage.put('backendState', {
      backend: String(msg.backend ?? ''),
      printer: String(msg.printer ?? ''),
      available: Array.isArray(msg.available) ? msg.available.slice(0, 20) : [],
      error,
    });
  }

  /** 새 작업을 에이전트에 넘긴다. 연결이 없으면 false (queued 로 남았다가 에이전트가 붙을 때 넘어감) */
  async dispatch(job: JobRow): Promise<boolean> {
    const ws = this.ctx.getWebSockets()[0];
    if (!ws) return false;
    ws.send(JSON.stringify({ type: 'job', job: toJobMessage(job) }));
    await this.env.DB.prepare(`UPDATE jobs SET status = 'dispatched', updated_at = ? WHERE id = ? AND status = 'queued'`)
      .bind(Date.now(), job.id)
      .run();
    return true;
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    const { gatewayId } = ws.deserializeAttachment() as Attachment;

    let msg: AgentMessage;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }

    if (msg.type === 'hello') {
      await this.saveBackendState(msg);
      // 연결이 끊긴 사이 놓친 결과 보고를 반영하고, 밀린 작업을 넘긴다
      for (const r of msg.recent ?? []) await this.updateStatus(gatewayId, r.jobId, r.attempt, r.status, r.detail);
      await this.flushPending(gatewayId, ws);
      return;
    }

    if (msg.type === 'backend' || msg.type === 'backend-error') {
      await this.saveBackendState(msg, msg.type === 'backend-error' ? msg.message : undefined);
      return;
    }

    if (msg.type === 'status') {
      await this.updateStatus(gatewayId, msg.jobId, msg.attempt, msg.status, msg.detail);
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {}
  }

  private async flushPending(gatewayId: string, ws: WebSocket): Promise<void> {
    const { results } = await this.env.DB.prepare(
      `SELECT * FROM jobs WHERE gateway_id = ? AND status IN ('queued', 'dispatched') ORDER BY created_at`,
    )
      .bind(gatewayId)
      .all<JobRow>();

    for (const job of results) {
      ws.send(JSON.stringify({ type: 'job', job: toJobMessage(job) }));
    }
    await this.env.DB.prepare(`UPDATE jobs SET status = 'dispatched', updated_at = ? WHERE gateway_id = ? AND status = 'queued'`)
      .bind(Date.now(), gatewayId)
      .run();
  }

  private async updateStatus(gatewayId: string, jobId: string, attempt: number, status: string, detail?: string): Promise<void> {
    if (!['sending', 'sent', 'failed'].includes(status)) return;

    // 끝난 작업·지난 시도의 보고는 무시한다. 다른 게이트웨이의 작업도 못 건드린다
    // PDF 는 보낸 뒤에도 보낸 기록에서 열어 볼 수 있게 보관 기간(RETENTION_DAYS)까지 둔다
    const now = Date.now();
    const n = Number(attempt) || 1;
    const text = detail?.slice(0, 2000) ?? null;
    const updated = await this.env.DB.prepare(
      `UPDATE jobs SET status = ?, detail = ?, updated_at = ?
        WHERE id = ? AND gateway_id = ? AND attempt = ? AND status NOT IN ('sent', 'failed')
`,
    )
      .bind(status, text, now, jobId, gatewayId, n)
      .run();
    if (!updated.meta.changes) return;

    // 시도별 기록: 시작 시각은 처음 보고 때 한 번만, 끝난 시각은 완료 · 실패 때
    const final = status === 'sent' || status === 'failed';
    await this.env.DB.prepare(
      `INSERT INTO job_attempts (job_id, attempt, status, detail, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (job_id, attempt) DO UPDATE SET
         status = excluded.status, detail = excluded.detail, finished_at = excluded.finished_at,
         started_at = COALESCE(job_attempts.started_at, excluded.started_at)`,
    )
      .bind(jobId, n, status, text, now, final ? now : null)
      .run();
  }
}
