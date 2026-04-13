const CACHE_NAME = 'game-cache-v1';
const urlsToCache = [
  './',
  './index.html',
  './otome.html',
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
  './otome_sounds/school_day.mp3',
  './otome_sounds/title_theme.mp3'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(urlsToCache);
    })
  );
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request).then(response => {
      return response || fetch(event.request);
    })
  );
});