// 이용약관 · 개인정보처리방침 · 신고·문의 페이지: 푸터 숫자 줄만 채운다
const $ = (id) => document.getElementById(id);

try {
  const s = await fetch('/api/stats').then((r) => r.json());
  $('stat-today').textContent = Number(s.today).toLocaleString('ko-KR');
  $('stat-total').textContent = Number(s.total).toLocaleString('ko-KR');
  $('stat-sent').textContent = Number(s.sent).toLocaleString('ko-KR');
} catch {}
