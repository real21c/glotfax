import type { GatewayHub } from './hub';

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  GATEWAY_HUB: DurableObjectNamespace<GatewayHub>;
  ASSETS: Fetcher;
  SESSION_SECRET: string;
  ADMIN_TOKEN: string;
  RETENTION_DAYS?: string;
  MAX_FILE_MB?: string;
  /** IP 이름표 JSON, 예: {"1.2.3.4": "본사"} */
  IP_LABELS?: string;
}

export type JobStatus = 'queued' | 'dispatched' | 'sending' | 'sent' | 'failed';

export const FINAL_STATUSES: readonly JobStatus[] = ['sent', 'failed'];

export interface TenantRow {
  id: string;
  name: string;
  sender_password_hash: string | null;
  session_version: number;
  default_fax_number: string | null;
  created_at: number;
}

export interface GatewayRow {
  id: string;
  tenant_id: string;
  name: string;
  token_hash: string;
  created_at: number;
  last_seen_at: number | null;
}

export interface JobRow {
  id: string;
  tenant_id: string;
  gateway_id: string;
  fax_number: string;
  file_key: string | null;
  file_name: string;
  file_size: number;
  status: JobStatus;
  detail: string | null;
  attempt: number;
  client_ip: string | null;
  user_agent: string | null;
  via: 'pwa' | 'browser' | null;
  device: string | null;
  created_at: number;
  updated_at: number;
}

/** 시도별 기록 (다시 보내도 앞 시도를 덮어쓰지 않음) */
export interface AttemptRow {
  job_id: string;
  attempt: number;
  status: 'sending' | 'sent' | 'failed';
  detail: string | null;
  started_at: number | null;
  finished_at: number | null;
}

export interface AccessLogRow {
  id: number;
  tenant_id: string;
  event: 'login' | 'login-failed' | 'login-blocked' | 'logout' | 'logout-all';
  ip: string | null;
  user_agent: string | null;
  via: 'pwa' | 'browser' | null;
  device: string | null;
  created_at: number;
}

/** 에이전트에게 넘기는 작업 정보. 파일은 에이전트가 /api/agent/jobs/:id/file 로 받아 간다 */
export interface JobMessage {
  id: string;
  attempt: number;
  faxNumber: string;
  fileName: string;
  /** pdf | txt | jpg | png — 에이전트가 이 확장자로 저장해 드라이버에 넘긴다 */
  fileType: string;
  fileSize: number;
}

export function toJobMessage(job: JobRow): JobMessage {
  return {
    id: job.id,
    attempt: job.attempt,
    faxNumber: job.fax_number,
    fileName: job.file_name,
    fileType: job.file_key?.split('.').pop() ?? 'pdf',
    fileSize: job.file_size,
  };
}

/** 게이트웨이에서 쓸 수 있는 백엔드 (에이전트가 찾아서 알려 줌) */
export interface AvailableBackend {
  backend: string;
  printer: string;
  label: string;
  /** false 면 화면에 보이지만 고를 수 없음 (예전 에이전트는 이 값이 없음 → 고를 수 있음) */
  enabled?: boolean;
  reasonCode?: 'no-linux' | 'no-driver' | 'no-printer';
  reason?: string;
}

export interface BackendState {
  backend: string;
  printer?: string;
  available?: AvailableBackend[];
}

/** 에이전트 → 서버 메시지 */
export type AgentMessage =
  | ({ type: 'hello'; version: string; recent?: { jobId: string; attempt: number; status: 'sent' | 'failed'; detail?: string }[] } & BackendState)
  | ({ type: 'backend' } & BackendState)
  | ({ type: 'backend-error'; message: string } & BackendState)
  | { type: 'status'; jobId: string; attempt: number; status: 'sending' | 'sent' | 'failed'; detail?: string };
