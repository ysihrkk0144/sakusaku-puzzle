/* ============================================================
   service-worker.js — さくさくスライドパズル
   バージョン: v10
   変更点（今回の修正）:
     - キャッシュキーを new URL(path, self.location).href で完全URL化
     - fetch: navigation リクエストはキャッシュ最優先（network-first しない）
     - Promise.allSettled で個別キャッシュ（1ファイル失敗で全滅しない）
     - service-worker.js 自体はASSETSに含めない
     - GET以外・http以外はスルー
     - 診断用: 現在のキャッシュ内容をpostMessageで返すハンドラを追加
============================================================ */

const SW_VERSION = 'v10';
const CACHE_NAME = `sakusaku-puzzle-${SW_VERSION}`;

// ★ service-worker.js 自体はリストに含めない
// ★ 相対パスで記述し、使用時に completeURL() で完全URL化する
const ASSET_PATHS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './puzzle-easy.jpg',
  './puzzle-normal.jpg',
  './puzzle-hard.jpg',
];

// ★ 完全URLに変換するヘルパー（パス解決のズレを防ぐ）
function completeURL(path) {
  return new URL(path, self.location).href;
}

const ASSETS = ASSET_PATHS.map(completeURL);
const INDEX_URL = completeURL('./index.html');

/* ---------- インストール ---------- */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async cache => {
      // ★ Promise.allSettled で個別キャッシュ（1件失敗で全滅しない）
      const results = await Promise.allSettled(
        ASSETS.map(url =>
          fetch(url, { cache: 'reload' }) // ★ ブラウザHTTPキャッシュを経由せず確実に取得
            .then(res => {
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              return cache.put(url, res);
            })
            .then(() => ({ url, ok: true }))
            .catch(err => ({ url, ok: false, err: err.message }))
        )
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
    ).then(async () => {
      await self.clients.claim();
      await notifyClients({ type: 'SW_ACTIVATED', version: SW_VERSION });
    })
  );
});

/* ---------- フェッチ ---------- */
self.addEventListener('fetch', event => {
  const req = event.request;

  // ★ GET以外・http以外はスルー（POST等はSWを介さず素通り）
  if (req.method !== 'GET') return;
  if (!req.url.startsWith('http')) return;

  // ★★★ 最重要: ナビゲーションリクエストはキャッシュ最優先 ★★★
  // ページ読み込み自体(URLバー/ホーム画面アイコンからの起動)が
  // network-firstだと、SW休止直後の機内モードでブラウザ標準の
  // ERR_FAILED画面が先に出てしまう。必ずキャッシュを先に見る。
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match(INDEX_URL).then(cached => {
        if (cached) return cached;
        // キャッシュに無ければネットワークを試し、失敗時もindex.htmlへフォールバック
        return fetch(req).catch(() => caches.match(INDEX_URL));
      })
    );
    return;
  }

  // 通常リソース: Cache First
  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(res => {
        if (!res || res.status !== 200 || res.type === 'opaque') return res;
        const clone = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(req, clone));
        return res;
      }).catch(() => {
        console.warn('[SW] オフライン & キャッシュなし:', req.url);
      });
    })
  );
});

/* ---------- 診断用メッセージハンドラ ---------- */
// index.html の診断パネルから状態確認リクエストを受け取り、
// キャッシュ内容・バージョン情報を返す
self.addEventListener('message', event => {
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
});

/* ---------- 全クライアントへ通知するヘルパー ---------- */
async function notifyClients(payload) {
  const clientsList = await self.clients.matchAll({ includeUncontrolled: true });
  clientsList.forEach(client => client.postMessage(payload));
}
