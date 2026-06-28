/* ============================================================
   service-worker.js — さくさくスライドパズル
   バージョン: v13
   方針: 完全オフライン優先 + 手動更新方式（Cache Only）
============================================================ */

const SW_VERSION = 'v13';
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

/* ---------- キャッシュ実行本体（install時・CACHE_NOW共通で使う） ---------- */
async function runCaching(cache) {
  // 各ファイルを最大3回リトライ。cacheオプションは no-store とデフォルトを交互に試す
  async function cacheOneWithRetry(url, maxRetry = 3) {
    let lastErr = null;
    for (let i = 0; i < maxRetry; i++) {
      const cacheMode = (i % 2 === 0) ? 'no-store' : 'default';
      try {
        const res = await fetch(url, { cache: cacheMode });
        if (!res.ok) throw new Error(`HTTP ${res.status} (mode:${cacheMode})`);
        await cache.put(url, res.clone());
        return { url, ok: true, attempt: i + 1, mode: cacheMode };
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
  const failedDetails = results
    .filter(r => !r.value?.ok)
    .map(r => ({ url: r.value?.url, err: r.value?.err || 'unknown' }));

  console.log('[SW] キャッシュ成功:', succeeded);
  if (failedDetails.length > 0) console.warn('[SW] キャッシュ失敗詳細:', failedDetails);

  return {
    succeeded: succeeded.length,
    failed: failedDetails.length,
    total: ASSETS.length,
    failedDetails,
  };
}

/* ---------- インストール ---------- */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async cache => {
      const result = await runCaching(cache);
      await notifyClients({ type: 'CACHE_DONE', ...result });
      // ★ skipWaiting() はここで呼ばない（手動更新方式のため）
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

/* ---------- フェッチ：Cache Only ---------- */
self.addEventListener('fetch', event => {
  const req = event.request;

  if (req.method !== 'GET') return;
  if (!req.url.startsWith('http')) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match(INDEX_URL).then(cached => {
        if (cached) return cached;
        return fetch(req).catch(() => caches.match(INDEX_URL));
      })
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
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

  // ★ 手動更新方式の核心: 「更新する」ボタンからのみ送信される
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  // ★ 「キャッシュを今すぐ手動で再取得する」ボタンから送信される
  if (event.data?.type === 'CACHE_NOW') {
    event.waitUntil(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        const result = await runCaching(cache);
        const client = event.source;
        if (client) {
          client.postMessage({ type: 'CACHE_NOW_RESULT', ...result });
        }
      })()
    );
  }
});

/* ---------- 全クライアントへ通知するヘルパー ---------- */
async function notifyClients(payload) {
  const clientsList = await self.clients.matchAll({ includeUncontrolled: true });
  clientsList.forEach(client => client.postMessage(payload));
}
