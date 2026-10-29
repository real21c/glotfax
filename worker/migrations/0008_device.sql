-- 기기 모델 코드 (예: SM-S918N). 브라우저 정보(User-Agent)에는 없어서 화면이 따로 물어봐 알려 준다 (안드로이드 크롬 계열만)
ALTER TABLE access_logs ADD COLUMN device TEXT;
ALTER TABLE jobs ADD COLUMN device TEXT;
