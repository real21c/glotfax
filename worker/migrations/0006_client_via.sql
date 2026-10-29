-- 홈 화면에 설치한 앱(PWA)으로 열었는지. 브라우저 정보(User-Agent)만으로는 크롬과 구분되지 않아 화면이 알려 준다
ALTER TABLE access_logs ADD COLUMN via TEXT;  -- pwa | browser
ALTER TABLE jobs ADD COLUMN via TEXT;
