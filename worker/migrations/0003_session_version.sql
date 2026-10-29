-- 비밀번호를 바꾸면 1씩 올린다. 쿠키에 든 값과 다르면 로그아웃 (다른 기기 세션 끊기)
ALTER TABLE tenants ADD COLUMN session_version INTEGER NOT NULL DEFAULT 1;
