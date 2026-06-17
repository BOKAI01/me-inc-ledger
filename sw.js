const CACHE_NAME = 'meinc-v5';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  'https://cdn.tailwindcss.com',
  'https://unpkg.com/react@18.3.1/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js',
  'https://unpkg.com/@babel/standalone@7.26.5/babel.min.js',
  'https://fonts.googleapis.com/css2?family=Noto+Serif+TC:wght@400;500;700&family=JetBrains+Mono:wght@400;500;600&display=swap'
];

// 安裝：預先快取核心資源
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS_TO_CACHE))
      .then(() => self.skipWaiting())
      .catch((err) => {
        console.warn('Cache addAll failed (some CDN assets may not be cacheable):', err);
        return self.skipWaiting();
      })
  );
});

// 啟動：清除舊版快取
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// 攔截請求：Cache First, Network Fallback（API 請求除外）
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // 不攔截 POST 請求與 Google Apps Script API 呼叫
  if (req.method !== 'GET') return;
  if (req.url.includes('script.google.com')) return;

  event.respondWith(
    caches.open(CACHE_NAME).then((cache) =>
      cache.match(req).then((cached) => {
        // 有快取 → 先回傳快取，背景更新
        if (cached) {
          // 背景靜默更新（Stale While Revalidate）
          fetch(req).then((resp) => {
            if (resp && resp.ok) {
              cache.put(req, resp.clone());
            }
          }).catch(() => {});
          return cached;
        }
        // 無快取 → 網路取得並快取
        return fetch(req).then((resp) => {
          if (resp && resp.ok) {
            cache.put(req, resp.clone());
          }
          return resp;
        }).catch(() => {
          // 完全離線且無快取
          return new Response('Offline', { status: 503, statusText: 'Offline' });
        });
      })
    )
  );
});
