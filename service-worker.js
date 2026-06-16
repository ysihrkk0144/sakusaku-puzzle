/* ============================================================
   service-worker.js — さくさくスライドパズル
   バージョン: v8
   変更点:
     - Promise.allSettled で個別キャッシュ（1ファイル失敗で全滅しない）
     - service-worker.js 自体はキャッシュリストから除外
     - GETリクエスト以外はスルー
     - キャッシュ完了をクライアントにメッセージ通知
============================================================ */

const CACHE_NAME = 'sakusaku-puzzle-v8';

// ★ service-worker.js 自体はリストに含めない
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './puzzle-easy.jpg',
  './puzzle-normal.jpg',
  './puzzle-hard.jpg',
];

/* ---------- インストール ---------- */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async cache => {
      // ★ Promise.allSettled で個別キャッシュ
      // 1ファイルが404などで失敗しても他のファイルのキャッシュは継続する
      const results = await Promise.allSettled(
        ASSETS.map(url =>
          cache.add(url).then(() => ({ url, ok: true }))
                        .catch(err => ({ url, ok: false, err: err.message }))
        )
      );

      // キャッシュ結果をログ出力
      const succeeded = results.filter(r => r.value?.ok).map(r => r.value.url);
      const failed    = results.filter(r => !r.value?.ok).map(r => r.value?.url);
      console.log('[SW] キャッシュ成功:', succeeded);
      if (failed.length > 0) console.warn('[SW] キャッシュ失敗:', failed);

      // ★ 完了通知をクライアントに送る（バナー表示用）
      const clients = await self.clients.matchAll({ includeUncontrolled: true });
      clients.forEach(client => client.postMessage({
        type:      'CACHE_DONE',
        succeeded: succeeded.length,
        failed:    failed.length,
        total:     ASSETS.length,
      }));
    }).then(() => self.skipWaiting())
  );
});

/* ---------- アクティベート ---------- */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => {
          console.log('[SW] 古いキャッシュ削除:', k);
          return caches.delete(k);
        })
      )
    ).then(() => self.clients.claim())
  );
});

/* ---------- フェッチ（Cache First） ---------- */
self.addEventListener('fetch', event => {
  // ★ GETリクエスト以外・http以外はスルー
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith('http')) return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      // キャッシュヒット → そのまま返す
      if (cached) return cached;

      // キャッシュミス → ネットワークから取得してキャッシュに追加
      return fetch(event.request).then(res => {
        if (!res || res.status !== 200 || res.type === 'opaque') return res;
        const clone = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
        return res;
      }).catch(() => {
        // オフライン & キャッシュなし → 何も返さない
        console.warn('[SW] オフライン & キャッシュなし:', event.request.url);
      });
    })
  );
});
