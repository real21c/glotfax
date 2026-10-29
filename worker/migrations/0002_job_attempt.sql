-- 다시 보내기마다 1씩 올린다. 에이전트는 (작업, 시도) 단위로 중복 전송을 막는다
ALTER TABLE jobs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;
