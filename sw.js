const CACHE_NAME = 'game-platform-cache-v1';

// ⚠️ 重要：ディレクトリごと（otome_images/* のような指定）はできません。
// キャッシュしたいファイルを1つずつ正確に書く必要があります。
const urlsToCache = [
  // プラットフォームのコア
  'index.html',
  'manifest.json',
  
  // 各ゲームのHTML
  'reversi.html',
  'shogi.html',
  'minesweeper.html',
  'majan.html',
  'daihugou.html',
  'hanahuda.html',
  'tetris.html',
  'blockzushi.html',
  'suica.html',
  'jump.html',
  'caring.html',
  'uno.html',
  'rpg.html',
  'otome.html',

  // 乙女ゲームの画像
  './otome_images/st_yuzuki_01.png',
  './otome_images/bg_beach_01.png',
  './otome_images/bg_city_cafe_01.png',
  './otome_images/bg_city_park_01.png',
  './otome_images/bg_city_shopping_01.png',
  './otome_images/bg_coastal_path_01.png',
  './otome_images/bg_observatory_night_01.png',
  './otome_images/bg_protagonist_room_01.png',
  './otome_images/bg_school_art_room_01.png',
  './otome_images/bg_school_classroom_01.png',
  './otome_images/bg_school_council_room_01.png',
  './otome_images/bg_school_entrance_01.png',
  './otome_images/bg_school_ground_01.png',
  './otome_images/bg_school_gym_01.png',
  './otome_images/bg_school_hallway_01.png',
  './otome_images/bg_school_library_01.png',
  './otome_images/bg_school_music_room_01.png',
  './otome_images/bg_school_rooftop_01.png',
  './otome_images/CG_kaito_01.png',
  './otome_images/CG_rinto_01.png',
  './otome_images/CG_rinto_02.png',
  './otome_images/CG_souma_01.png',
  './otome_images/st_aoi_01.png',
  './otome_images/st_hayate_01.png',
  './otome_images/st_hiyori_01.png',
  './otome_images/st_kaito_01.png',
  './otome_images/st_rinto_01.png',
  './otome_images/st_souma_01.png',

  // 乙女ゲームの音声
  './otome_sounds/school_day.mp3',
  './otome_sounds/title_theme.mp3'
];

// インストール時にリストのファイルをすべて事前キャッシュ！
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('Opened cache and pre-caching all assets');
      return cache.addAll(urlsToCache);
    })
  );
});

// 通信の処理（キャッシュ優先、なければネットワークへ）
self.addEventListener('fetch', event => {
  if (!event.request.url.startsWith('http')) return;

  event.respondWith(
    caches.match(event.request).then(response => {
      // キャッシュにあれば即座にそれを返す
      if (response) return response;
      
      // 事前キャッシュのリストに書き忘れたファイルがあった場合の保険として、
      // ネットワークから取得したものをその場でキャッシュに追加する処理
      return fetch(event.request).then(networkResponse => {
        return caches.open(CACHE_NAME).then(cache => {
          cache.put(event.request, networkResponse.clone());
          return networkResponse;
        });
      });
    })
  );
});

// 古いキャッシュのお掃除
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      );
    })
  );
});