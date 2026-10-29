-- tenant: 팩스를 쓰는 단위(게이트웨이 묶음 하나). 지금은 'default' 하나, 나중에 계정이 붙으면 여러 개
CREATE TABLE tenants (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  sender_password_hash TEXT,
  created_at           INTEGER NOT NULL
);

-- gateway: 팩스 복합기가 연결된 PC 에서 도는 에이전트
CREATE TABLE gateways (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER
);

-- job: 팩스 한 건. status: queued → dispatched → sending → sent | failed
CREATE TABLE jobs (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  gateway_id TEXT NOT NULL REFERENCES gateways(id),
  fax_number TEXT NOT NULL,
  file_key   TEXT,
  file_name  TEXT NOT NULL,
  file_size  INTEGER NOT NULL,
  status     TEXT NOT NULL,
  detail     TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX jobs_tenant_created  ON jobs (tenant_id, created_at DESC);
CREATE INDEX jobs_gateway_status  ON jobs (gateway_id, status);
