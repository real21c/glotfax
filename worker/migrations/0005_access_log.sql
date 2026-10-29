-- 로그인 · 로그아웃 기록 (IP, 브라우저 정보). 설정 화면의 "로그인 기록"에서 본다
CREATE TABLE access_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  event TEXT NOT NULL,          -- login | login-failed | logout | logout-all
  ip TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX access_logs_tenant_time ON access_logs (tenant_id, created_at DESC);

-- 팩스를 올린 곳 (보낸 기록에 함께 보여 줌)
ALTER TABLE jobs ADD COLUMN client_ip TEXT;
ALTER TABLE jobs ADD COLUMN user_agent TEXT;
