/* ============================================================
   service-worker.js — さくさくスライドパズル
   バージョン: v12
   方針転換: 完全オフライン優先 + 手動更新方式
   ─────────────────────────────────────────────────────────
   ・通常時はネットワークに一切問い合わせない（Cache Only）
   ・更新は「更新確認」ボタンを押した時だけ実行する
   ・これにより「裏で勝手に動く自動更新」と
     「機内モードのタイミング」が衝突する問題を根本的に回避する
============================================================ */

const SW_VERSION = 'v12';
const CACHE_NAME = `sakusaku-puzzle-${SW_VERSION}`;

const ASSET_PATHS = [
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './puzzle-easy.jpg',
  './puzzle-normal.jpg',
  './puzzle-hard.jpg',
];

function completeURL(path) {
  return new URL(path, self.location).href;
}

const ASSETS = ASSET_PATHS.map(completeURL);
const INDEX_URL = completeURL('./index.html');

/* ---------- インストール ---------- */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async cache => {
      // 各ファイルを最大3回までリトライしてキャッシュする
      async function cacheOneWithRetry(url, maxRetry = 3) {
        let lastErr = null;
        for (let i = 0; i < maxRetry; i++) {
          try {
            const res = await fetch(url, { cache: 'no-store' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            await cache.put(url, res.clone());
            return { url, ok: true, attempt: i + 1 };
          } catch (err) {
            lastErr = err;
            await new Promise(r => setTimeout(r, 400));
          }
        }
        return { url, ok: false, err: lastErr?.message };
      }

      const results = await Promise.allSettled(
        ASSETS.map(url => cacheOneWithRetry(url))
      );

      const succeeded = results.filter(r => r.value?.ok).map(r => r.value.url);
      const failed    = results.filter(r => !r.value?.ok).map(r => r.value?.url);
      console.log('[SW] キャッシュ成功:', succeeded);
      if (failed.length > 0) console.warn('[SW] キャッシュ失敗:', failed);

      await notifyClients({
        type: 'CACHE_DONE',
        succeeded: succeeded.length,
        failed: failed.length,
        total: ASSETS.length,
        failedUrls: failed,
      });

      // ★ 重要: ここでは skipWaiting() を呼ばない。
      // 手動更新方式では、ユーザーが明示的に「更新する」を押すまで
      // 現在動いているSWを維持し、新しいSWは waiting 状態のまま待機させる。
    })
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
    ).then(async () => {
      await self.clients.claim();
      await notifyClients({ type: 'SW_ACTIVATED', version: SW_VERSION });
    })
  );
});

/* ---------- フェッチ：Cache Only（完全オフライン優先） ---------- */
self.addEventListener('fetch', event => {
  const req = event.request;

  if (req.method !== 'GET') return;
  if (!req.url.startsWith('http')) return;

  // ナビゲーションリクエスト → 常にキャッシュのindex.htmlを返す
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match(INDEX_URL).then(cached => {
        if (cached) return cached;
        // 万一キャッシュに無い場合のみネットワークにフォールバック
        return fetch(req).catch(() => caches.match(INDEX_URL));
      })
    );
    return;
  }

  // 通常リソース → Cache Only
  // ネットワークには問い合わせない。無ければ諦める（更新ボタンで取得する）
  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      // キャッシュに無ければネットワークを一応試す（初回未キャッシュ時の保険）
      return fetch(req).catch(() => {
        console.warn('[SW] キャッシュなし・オフライン:', req.url);
      });
    })
  );
});

/* ---------- メッセージハンドラ ---------- */
self.addEventListener('message', event => {
  // 診断パネルからのキャッシュ内容問い合わせ
  if (event.data?.type === 'GET_DIAGNOSTIC') {
    event.waitUntil(
      caches.open(CACHE_NAME).then(cache => cache.keys()).then(keys => {
        const cachedUrls = keys.map(k => k.url);
        event.source.postMessage({
          type: 'DIAGNOSTIC_RESULT',
          version: SW_VERSION,
          cacheName: CACHE_NAME,
          cachedCount: cachedUrls.length,
          cachedUrls,
          expectedCount: ASSETS.length,
        });
      })
    );
  }

  // ★ 手動更新方式の核心: ユーザーが「更新する」を押した時だけ
  //   waiting中の新SWを有効化する
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

/* ---------- 全クライアントへ通知するヘルパー ---------- */
async function notifyClients(payload) {
  const clientsList = await self.clients.matchAll({ includeUncontrolled: true });
  clientsList.forEach(client => client.postMessage(payload));
}
