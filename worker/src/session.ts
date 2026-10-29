import { b64url, b64urlDecode, sign, verifySignature } from './crypto';

export const SESSION_COOKIE = 'gf_session';
const MAX_AGE_SEC = 60 * 60 * 24 * 30;

interface SessionPayload {
  t: string; // tenant id
  v: number; // tenants.session_version — 비밀번호를 바꾸면 달라져서 다른 기기가 로그아웃된다
  exp: number; // ms
}

export interface Session {
  tenantId: string;
  version: number;
}

export async function createSessionCookie(secret: string, tenantId: string, version: number): Promise<string> {
  const payload: SessionPayload = { t: tenantId, v: version, exp: Date.now() + MAX_AGE_SEC * 1000 };
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const value = `${body}.${await sign(secret, body)}`;
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${MAX_AGE_SEC}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

export async function readSession(secret: string, cookieHeader: string | null | undefined): Promise<Session | null> {
  const value = cookieHeader
    ?.split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  if (!value) return null;

  const [body, sig] = value.split('.');
  if (!body || !sig) return null;
  try {
    if (!(await verifySignature(secret, body, sig))) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as SessionPayload;
    if (typeof payload.t !== 'string' || payload.exp < Date.now()) return null;
    return { tenantId: payload.t, version: Number(payload.v) || 1 };
  } catch {
    return null;
  }
}
