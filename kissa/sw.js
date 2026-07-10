// PWA 外壳缓存。版本名必须随接口/前端升级一起变,避免部署后仍运行旧 Beta 代码。
const CACHE = 'kissa-ga-20260710-v2';
const SHELL = ['./', './index.html', './app.js?v=20260710-ga2', './providers.js?v=20260710-ga2', './glossary-builtin.js?v=20260710-ga2',
  './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
  ).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/') || e.request.method !== 'GET') return; // API 不缓存

  // 页面和代码优先走网络,上线修复后刷新即可拿到新版;断网时再退回本地缓存。
  const isCode = e.request.mode === 'navigate' || /\.(?:html|js)$/.test(url.pathname);
  if (isCode) {
    e.respondWith(
      fetch(e.request).then((r) => {
        const copy = r.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return r;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => {
      const copy = r.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return r;
    }))
  );
});
