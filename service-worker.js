/* =====================================================
   service-worker.js  ─  さくさくスライドパズル PWA
   オフラインキャッシュ戦略: Cache First
   ===================================================== */

const CACHE_NAME = 'sakusaku-puzzle-v1';

// キャッシュ対象ファイル一覧
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './puzzle-image.svg',
  './icon.svg'
];

/* ---------- インストール ---------- */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('[SW] キャッシュ登録中...');
      return cache.addAll(ASSETS);
    }).then(() => {
      console.log('[SW] インストール完了');
      return self.skipWaiting(); // 即座に有効化
    })
  );
});

/* ---------- アクティベート ---------- */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys
          .filter(key => key !== CACHE_NAME) // 古いキャッシュを削除
          .map(key => {
            console.log('[SW] 古いキャッシュ削除:', key);
            return caches.delete(key);
          })
      );
    }).then(() => {
      console.log('[SW] アクティベート完了');
      return self.clients.claim(); // 既存のページも即座にコントロール
    })
  );
});

/* ---------- フェッチ (Cache First 戦略) ---------- */
self.addEventListener('fetch', event => {
  // chrome-extension や POST リクエストはスキップ
  if (!event.request.url.startsWith('http') || event.request.method !== 'GET') {
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) {
        // キャッシュがあればそれを返す（オフライン対応）
        return cached;
      }
      // キャッシュにない場合はネットワークから取得してキャッシュに追加
      return fetch(event.request).then(response => {
        if (!response || response.status !== 200 || response.type === 'opaque') {
          return response;
        }
        const toCache = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, toCache));
        return response;
      }).catch(() => {
        // ネットワークもなければ何もしない（エラーはアプリ側で処理）
        console.warn('[SW] オフライン & キャッシュなし:', event.request.url);
      });
    })
  );
});
