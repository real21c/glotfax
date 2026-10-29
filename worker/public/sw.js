// 공유 메뉴(Web Share Target)로 들어온 파일(PDF·TXT·JPG·PNG)을 받아 두고 첫 화면으로 넘긴다.
// 화면(app.js)이 캐시에서 꺼내 파일 선택 칸에 넣는다.
const SHARE_CACHE = 'glotfax-share';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === 'POST' && url.pathname === '/share') {
    event.respondWith(receiveShare(event.request));
  }
});

async function receiveShare(request) {
  try {
    const form = await request.formData();
    const files = form.getAll('file').filter((f) => f instanceof File);
    if (!files.length) return Response.redirect('/?share=retry', 303);

    const cache = await caches.open(SHARE_CACHE);
    // 지난번에 남은 것 정리 후, 공유된 순서대로 넣는다
    for (const req of await cache.keys()) await cache.delete(req);
    await Promise.all(
      files.map((file, i) =>
        cache.put(
          `/shared-file/${i}`,
          new Response(file, {
            headers: {
              'Content-Type': file.type || 'application/octet-stream',
              'X-File-Name': encodeURIComponent(file.name || 'document'),
              'X-File-Order': String(i),
            },
          }),
        ),
      ),
    );
    return Response.redirect('/?shared=1', 303);
  } catch {
    return Response.redirect('/?share=retry', 303);
  }
}
