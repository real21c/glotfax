-- 기본 받는 번호. 보낸 기록이 없을 때 받는 번호 칸에 채운다 (설정 화면에서 바꿈)
ALTER TABLE tenants ADD COLUMN default_fax_number TEXT;
