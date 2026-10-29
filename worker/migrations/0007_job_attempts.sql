-- 시도별 기록. 다시 보내도 앞 시도의 진행 단계 · 결과를 덮어쓰지 않고 남긴다
CREATE TABLE job_attempts (
  job_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,         -- sending | sent | failed
  detail TEXT,
  started_at INTEGER,           -- 게이트웨이가 보내기 시작한 시각
  finished_at INTEGER,          -- 끝난 시각
  PRIMARY KEY (job_id, attempt)
);

-- 이미 끝난 작업은 마지막 시도만 옮겨 둔다 (앞 시도는 이미 덮어써져 없음)
INSERT INTO job_attempts (job_id, attempt, status, detail, started_at, finished_at)
SELECT id, attempt, status, detail, NULL, updated_at FROM jobs WHERE status IN ('sent', 'failed');
