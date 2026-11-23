const CACHE_NAME = 'game-platform-cache-v142';
/* 実行時キャッシュ（バージョンをまたいで保持する）。
   ゲーム本体や画像は「初めて開いた時」にここへ入り、更新のたびに
   消えることがない。更新で消えるのは下のコアキャッシュだけ。 */
const RUNTIME_CACHE = 'game-platform-runtime-v1';

// 事前キャッシュはプラットフォームのコアだけ（約0.5MB）。
// ⚠️ cache.addAll は原子的：リストのファイルが1つでも存在しないと
// インストール全体が失敗する。実在するファイルだけを書くこと。
// 各ゲームのHTML・乙女ゲームの画像/音声は事前キャッシュしない
// （開いた時に実行時キャッシュへ入る方式に v78 で変更。以前は
// 画像だけで数十MBあり、更新のたびに全再ダウンロードが走っていた）。
const urlsToCache = [
  'index.html',
  'friends.js',
  'account.js',
  'match.js',
  'manifest.json',
  'icon-192.png',
];
const CORE_SET = new Set(urlsToCache.map(u => new URL(u, self.location.href).pathname));

// インストール時にコアだけを事前キャッシュする
self.addEventListener('install', event => {
  // 新バージョンは待たずに即有効化する（ポータルの更新ボタンと連動）
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(urlsToCache))
  );
});

// ポータルの更新ボタンからの即時有効化リクエスト
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function isAssetRequest(url) {
  return /\.(png|jpe?g|gif|webp|svg|mp3|wav|ogg|ico)$/i.test(url.pathname);
}

// 通信の処理
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 外部（CDN・Firebase等）は素通し

  // コア：バージョンと同期したキャッシュ優先（なければネット→コアキャッシュへ）
  if (CORE_SET.has(url.pathname)) {
    event.respondWith(
      caches.open(CACHE_NAME).then(cache =>
        cache.match(req).then(hit => hit || fetch(req).then(res => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        }))
      )
    );
    return;
  }

  // 画像・音声：キャッシュ優先（初回だけネットから取得して実行時キャッシュへ）
  if (isAssetRequest(url)) {
    event.respondWith(
      caches.open(RUNTIME_CACHE).then(cache =>
        cache.match(req).then(hit => hit || fetch(req).then(res => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        }))
      )
    );
    return;
  }

  // それ以外（各ゲームのHTMLなど）：ネット優先で常に最新を取りに行き、
  // 取得できたら実行時キャッシュに控えを残す。オフライン時は控えを返す。
  // HTMLは HTTP キャッシュを再検証させて取りに行く（GitHub Pages の
  // max-age=600 のせいで「ネット優先」でも古い控えが返ることがあったため）。
  const isHtml = req.mode === 'navigate' || /\.html$/i.test(url.pathname);
  event.respondWith(
    fetch(req, isHtml ? { cache: 'no-cache' } : undefined).then(res => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(RUNTIME_CACHE).then(cache => cache.put(req, copy));
      }
      return res;
    }).catch(() =>
      caches.open(RUNTIME_CACHE).then(cache => cache.match(req)).then(hit => {
        if (hit) return hit;
        throw new Error('offline and not cached');
      })
    )
  );
});

// 古いキャッシュのお掃除（実行時キャッシュは残す）
// ＋ 新バージョンが有効化されたら、実行時キャッシュ内のゲームHTMLだけを
// 破棄する。これで「ホームの更新ボタンで更新が見つかった」あとは、
// 次にゲームを開いた時に必ず新しいゲームが落ちてくるようになる。
// 画像・音声パート等の資産は消さない（再ダウンロードさせないため）。
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.filter(name => name !== CACHE_NAME && name !== RUNTIME_CACHE)
          .map(name => caches.delete(name))
      );
    }).then(() =>
      caches.open(RUNTIME_CACHE).then(cache =>
        cache.keys().then(reqs => Promise.all(
          reqs.filter(r => /\.html$/i.test(new URL(r.url).pathname))
            .map(r => cache.delete(r))
        ))
      )
    ).then(() => self.clients.claim())
  );
});
