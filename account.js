/* ============================================================
   PlayWeb アカウント基盤（account.js）
   ------------------------------------------------------------
   Firebase（Auth + Firestore）を使った共通モジュール。
   friends.js と同様に全ページへ <script src="account.js"> で組み込む
   （friends.js の直後に置くこと）。

   提供するもの:
   - ログイン管理: ユーザー名＋パスワード（Auth はメール/パスワード方式のため、
     ユーザー名を "<username>@playweb.local" に変換して使う）
   - プロフィール: Firestore users/{uid}（公開: username, usernameLower,
     friendCode, online, lastSeen, currentGame, createdAt）
     usernames/{usernameLower} -> {uid}（重複防止・検索用）
     codes/{フレンドコード} -> {uid}（コード追加したフレンドの uid 解決用）
   - クラウドセーブ同期: localStorage のゲームデータ（バックアップ対象と同範囲。
     ただし Firebase Auth のキー・account.js 内部キー・退避キー・
     フレンド層のキー playweb_profile/friends/chats/unread は除外）を
     users/{uid}/saves/{encodeURIComponent(key)} にキー単位で同期。
     ログイン時にキーごとの更新時刻を比べて新しい方を正とし、
     クラウド→ローカル適用の前には playweb_pre_import_backup へ退避する。
   - フレンド基盤（ログイン時）: フレンド一覧は users/{uid}/data/friends と同期し、
     ユーザー名検索で追加できる。プレゼンスは公開プロフィールの
     online/lastSeen/currentGame をハートビート更新して使う。
     招待は invites コレクション（オフラインでも届く）、チャットは
     messages コレクション（当事者のみ）に保存する。実際の対戦接続は
     従来どおり PeerJS ルームへ合流する。
   - 未ログイン時・SDK が読み込めない環境では一切何も変えず、
     従来の friends.js（コード制・PeerJS）の動作がそのまま動く。

   公開 API: window.PWAccount（下部参照）
   ============================================================ */
(function () {
  'use strict';
  if (window.__pwAccountLoaded) return;
  window.__pwAccountLoaded = true;

  /* ---------------- Firebase 設定（Web公開前提の接続情報） ---------------- */
  var FIREBASE_CONFIG = {
    apiKey: 'AIzaSyDdhlAbqi0vZY8ltsk0tX2V0XXxjneWn0g',
    authDomain: 'playweb-cfbc5.firebaseapp.com',
    projectId: 'playweb-cfbc5',
    storageBucket: 'playweb-cfbc5.firebasestorage.app',
    messagingSenderId: '1005893480472',
    appId: '1:1005893480472:web:3af58efed1436086d2d36d'
  };
  var SDK_VER = '10.12.2';
  var SDK_BASE = 'https://www.gstatic.com/firebasejs/' + SDK_VER + '/';

  /* ---------------- 定数 ---------------- */
  var EMAIL_DOMAIN = '@playweb.local';
  var USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,15}$/; /* 3〜16文字・半角英数字と _ - */
  var LS_META = 'pwacct_meta';
  var LS_STASH = 'playweb_pre_import_backup';
  var FRIENDS_KEYS = {
    playweb_profile: true, playweb_friends: true,
    playweb_chats: true, playweb_unread: true
  };
  var PRESENCE_STALE_MS = 90000;   /* lastSeen がこれより古ければオフライン扱い */
  var HEARTBEAT_MS = 30000;
  var UPLOAD_DEBOUNCE_MS = 2500;
  var INVITE_TTL_MS = 24 * 60 * 60 * 1000;

  /* ---------------- ユーティリティ ---------------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function hashStr(s) {
    s = String(s == null ? '' : s);
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36) + ':' + s.length;
  }
  function nowMs() { return Date.now(); }
  function inferGame() {
    if (typeof window.PW_GAME === 'string' && window.PW_GAME) return window.PW_GAME;
    var f = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
    if (f === '' || f === 'index.html') return 'portal';
    return f.replace(/\.html$/, '');
  }
  var MY_GAME = inferGame();

  /* ユーザー名バリデーション: {ok:true} | {ok:false, error} */
  function validateUsername(name) {
    if (typeof name !== 'string') return { ok: false, error: 'ユーザー名を入力してください' };
    var n = name.trim();
    if (n.length < 3 || n.length > 16) return { ok: false, error: 'ユーザー名は3〜16文字で入力してください' };
    if (!USERNAME_RE.test(n)) return { ok: false, error: 'ユーザー名は半角英数字と「_」「-」だけ使えます（先頭は英数字）' };
    return { ok: true, name: n };
  }
  function usernameToEmail(name) {
    return String(name).trim().toLowerCase() + EMAIL_DOMAIN;
  }
  function validatePassword(pw) {
    if (typeof pw !== 'string' || pw.length < 6) return { ok: false, error: 'パスワードは6文字以上で入力してください' };
    if (pw.length > 64) return { ok: false, error: 'パスワードは64文字以内で入力してください' };
    return { ok: true };
  }
  function authErrorMessage(e) {
    var code = (e && e.code) || '';
    switch (code) {
      case 'auth/user-not-found':
      case 'auth/invalid-credential':
      case 'auth/wrong-password':
        return 'ユーザー名またはパスワードが違います';
      case 'auth/email-already-in-use':
        return 'このユーザー名は既に使われています';
      case 'auth/weak-password':
        return 'パスワードが弱すぎます（6文字以上にしてください）';
      case 'auth/too-many-requests':
        return '試行回数が多すぎます。しばらく待ってからお試しください';
      case 'auth/network-request-failed':
        return '通信できませんでした。ネットワークを確認してください';
      case 'auth/invalid-email':
        return 'ユーザー名の形式が正しくありません';
      default:
        return 'エラーが発生しました' + (code ? '（' + code + '）' : '');
    }
  }

  /* ---------------- 状態 ---------------- */
  var fb = null;              /* {auth, db} */
  var sdkState = 'loading';   /* loading | ready | unavailable */
  var me = null;              /* {uid, username, usernameLower} */
  var servicesOn = false;
  var unsubs = [];            /* Firestore リスナ解除関数 */
  var timers = [];            /* setInterval id */
  var pendingUsername = null; /* 新規登録直後のプロフィール作成用 */
  var statusText = '';        /* モーダルに表示する同期状態など */
  var modalMode = 'login';    /* login | signup */

  function cloudActive() { return !!(me && servicesOn && fb); }
  function myFriendCode() {
    try {
      var p = JSON.parse(localStorage.getItem('playweb_profile') || 'null');
      if (p && typeof p.code === 'string') return p.code;
    } catch (e) {}
    return '';
  }

  /* ---------------- 同期メタ（localStorage） ----------------
     pwacct_meta: {
       keys: { <lskey>: {h: ハッシュ, t: 最終変更/同期時刻ms, del: 削除済みか} },
       chatSeen: { <フレンドコード>: 取り込み済みチャットの最大ts },
       friendsHash: クラウドと一致しているフレンド一覧のハッシュ
     } */
  var meta = loadMeta();
  function loadMeta() {
    try {
      var m = JSON.parse(localStorage.getItem(LS_META) || 'null');
      if (m && typeof m === 'object' && m.keys && typeof m.keys === 'object') {
        if (!m.chatSeen) m.chatSeen = {};
        return m;
      }
    } catch (e) {}
    return { keys: {}, chatSeen: {}, friendsHash: '' };
  }
  var metaSaveTimer = null;
  function saveMeta() {
    if (metaSaveTimer) return;
    metaSaveTimer = setTimeout(function () {
      metaSaveTimer = null;
      try { localStorage.setItem(LS_META, JSON.stringify(meta)); } catch (e) {}
    }, 300);
  }
  function saveMetaNow() {
    if (metaSaveTimer) { clearTimeout(metaSaveTimer); metaSaveTimer = null; }
    try { localStorage.setItem(LS_META, JSON.stringify(meta)); } catch (e) {}
  }

  /* ---------------- セーブ同期の対象判定 ---------------- */
  function syncableKey(k) {
    if (!k || typeof k !== 'string') return false;
    if (k === LS_STASH) return false;
    if (k.indexOf('firebase:') === 0) return false;   /* Firebase Auth 自体のキー */
    if (k.indexOf('pwacct_') === 0) return false;     /* account.js 内部キー */
    if (FRIENDS_KEYS[k]) return false;                /* フレンド層は専用経路で同期 */
    return true;
  }
  function collectLocal() {
    var data = {};
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (syncableKey(k)) data[k] = localStorage.getItem(k);
      }
    } catch (e) {}
    return data;
  }
  /* 起動時: 既存キーをメタと照合する。
     - 未登録のキーは「今の時刻で観測した」ものとして登録する
       （初回ログイン時はローカル側が新しい扱いになり、移行アップロードになる）。
     - 登録済みでも値が変わっているキーは、account.js が見ていない間に外部で
       変更された（例: ポータルのバックアップ読み込み）ものとして、時刻を今に更新する
       （読み込んだデータを本人の最新意思として扱い、クラウドの古い値で上書きしない）。 */
  (function baselineMeta() {
    var data = collectLocal();
    var t = nowMs(), changed = false;
    Object.keys(data).forEach(function (k) {
      var h = hashStr(data[k]);
      var m = meta.keys[k];
      if (!m || m.del || m.h !== h) { meta.keys[k] = { h: h, t: t, del: false }; changed = true; }
    });
    if (changed) saveMeta();
  })();

  /* ---------------- localStorage 書き込みの監視 ----------------
     ゲーム側の保存を検知して、メタ更新＋自動アップロード予約、
     フレンド一覧の変更はフレンド同期へ回す。 */
  var dirtyKeys = {};         /* key -> true（アップロード待ち） */
  var applyingCloud = false;  /* クラウド適用中の書き込みは dirty にしない */
  var uploadTimer = null;
  var friendsUploadTimer = null;

  function onLocalWrite(key, value) {
    if (!syncableKey(key) && key !== 'playweb_friends') return;
    if (key === 'playweb_friends') { scheduleFriendsUpload(); return; }
    var t = nowMs();
    if (applyingCloud) return; /* メタは適用側が直接書く */
    meta.keys[key] = { h: hashStr(value), t: t, del: false };
    saveMeta();
    dirtyKeys[key] = true;
    scheduleUpload();
  }
  function onLocalRemove(key) {
    if (!syncableKey(key)) return;
    if (applyingCloud) return;
    meta.keys[key] = { h: '', t: nowMs(), del: true };
    saveMeta();
    dirtyKeys[key] = true;
    scheduleUpload();
  }
  (function patchStorage() {
    try {
      var proto = window.Storage && Storage.prototype;
      if (!proto || proto.__pwAcctPatched) return;
      var origSet = proto.setItem, origRemove = proto.removeItem;
      proto.setItem = function (k, v) {
        var r = origSet.apply(this, arguments);
        try { if (this === window.localStorage) onLocalWrite(String(k), String(v)); } catch (e) {}
        return r;
      };
      proto.removeItem = function (k) {
        var r = origRemove.apply(this, arguments);
        try { if (this === window.localStorage) onLocalRemove(String(k)); } catch (e) {}
        return r;
      };
      proto.__pwAcctPatched = true;
    } catch (e) {}
  })();
  function scheduleUpload() {
    if (!cloudActive()) return;
    if (uploadTimer) clearTimeout(uploadTimer);
    uploadTimer = setTimeout(function () { uploadTimer = null; uploadDirty(); }, UPLOAD_DEBOUNCE_MS);
  }
  function scheduleFriendsUpload() {
    if (!cloudActive()) return;
    if (friendsUploadTimer) clearTimeout(friendsUploadTimer);
    friendsUploadTimer = setTimeout(function () { friendsUploadTimer = null; uploadFriends(); }, UPLOAD_DEBOUNCE_MS);
  }

  /* ---------------- Firestore 参照ヘルパ ---------------- */
  function userDoc(uid) { return fb.db.doc('users/' + uid); }
  function savesCol(uid) { return fb.db.collection('users/' + uid + '/saves'); }
  function saveDoc(uid, key) { return fb.db.doc('users/' + uid + '/saves/' + encodeURIComponent(key)); }
  function friendsDoc(uid) { return fb.db.doc('users/' + uid + '/data/friends'); }

  /* ---------------- クラウドセーブ同期 ---------------- */
  function stashCurrentLocal() {
    /* ポータルのバックアップと同じ形式で現在の全データを退避する */
    try {
      var data = {};
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k !== LS_STASH) data[k] = localStorage.getItem(k);
      }
      localStorage.setItem(LS_STASH, JSON.stringify({ savedAt: new Date().toISOString(), data: data }));
    } catch (e) {}
  }

  /* ログイン時（とフォーカス復帰時）の同期: キーごとに更新時刻を比べ新しい方を正とする */
  var syncing = false;
  function syncSaves() {
    if (!cloudActive() || syncing) return Promise.resolve(false);
    syncing = true;
    setStatus('セーブデータを同期中…');
    var uid = me.uid;
    return savesCol(uid).get().then(function (snap) {
      var cloud = {};
      snap.forEach(function (d) {
        try { cloud[decodeURIComponent(d.id)] = d.data(); } catch (e) {}
      });
      var local = collectLocal();
      var apply = {};       /* key -> 値（クラウドが新しい） */
      var applyDel = [];    /* key（クラウドで削除済み） */
      var upload = [];      /* key（ローカルが新しい） */
      var uploadDel = [];   /* key（ローカルで削除済み） */
      var allKeys = {};
      Object.keys(local).forEach(function (k) { allKeys[k] = true; });
      Object.keys(cloud).forEach(function (k) { allKeys[k] = true; });
      Object.keys(meta.keys).forEach(function (k) { if (syncableKey(k)) allKeys[k] = true; });

      Object.keys(allKeys).forEach(function (k) {
        var c = cloud[k];
        var hasLocal = Object.prototype.hasOwnProperty.call(local, k);
        var lv = hasLocal ? local[k] : null;
        var m = meta.keys[k];
        var localTs = m ? m.t : 0;
        if (c && !c.deleted) {
          if (!hasLocal) {
            if (m && m.del && localTs >= (c.updatedAt || 0)) { uploadDel.push(k); return; }
            apply[k] = c.v; return;
          }
          if (hashStr(lv) === hashStr(c.v)) {
            meta.keys[k] = { h: hashStr(lv), t: Math.max(localTs, c.updatedAt || 0), del: false };
            return;
          }
          if ((c.updatedAt || 0) >= localTs) apply[k] = c.v;
          else upload.push(k);
        } else if (c && c.deleted) {
          if (hasLocal) {
            var changed = !m || m.h !== hashStr(lv);
            if (!changed && (c.updatedAt || 0) >= localTs) applyDel.push(k);
            else if ((c.updatedAt || 0) < localTs) upload.push(k);
            else applyDel.push(k);
          } else {
            meta.keys[k] = { h: '', t: Math.max(localTs, c.updatedAt || 0), del: true };
          }
        } else {
          /* クラウドに無い */
          if (hasLocal) upload.push(k);
        }
      });

      var jobs = [];
      if (Object.keys(apply).length || applyDel.length) {
        stashCurrentLocal(); /* 適用前に必ず退避（ポータルの「読み込み前に戻す」で復旧可能） */
        applyingCloud = true;
        try {
          Object.keys(apply).forEach(function (k) {
            localStorage.setItem(k, apply[k]);
            meta.keys[k] = { h: hashStr(apply[k]), t: (cloud[k].updatedAt || nowMs()), del: false };
            delete dirtyKeys[k];
          });
          applyDel.forEach(function (k) {
            localStorage.removeItem(k);
            meta.keys[k] = { h: '', t: (cloud[k].updatedAt || nowMs()), del: true };
            delete dirtyKeys[k];
          });
        } catch (e) {}
        applyingCloud = false;
      }
      var t = nowMs();
      upload.forEach(function (k) {
        jobs.push(saveDoc(uid, k).set({ v: local[k], updatedAt: t, deleted: false }).then(function () {
          meta.keys[k] = { h: hashStr(local[k]), t: t, del: false };
          delete dirtyKeys[k];
        }).catch(function () {}));
      });
      uploadDel.forEach(function (k) {
        jobs.push(saveDoc(uid, k).set({ v: null, updatedAt: t, deleted: true }).then(function () {
          meta.keys[k] = { h: '', t: t, del: true };
          delete dirtyKeys[k];
        }).catch(function () {}));
      });
      return Promise.all(jobs).then(function () {
        saveMetaNow();
        setStatus('クラウドセーブ同期済み（' + new Date().toLocaleTimeString() + '）');
        syncing = false;
        return true;
      });
    }).catch(function () {
      syncing = false;
      setStatus('セーブ同期に失敗しました（通信環境を確認してください）');
      return false;
    });
  }

  function uploadDirty() {
    if (!cloudActive()) return;
    var keys = Object.keys(dirtyKeys);
    if (!keys.length) return;
    var uid = me.uid, t = nowMs();
    keys.forEach(function (k) {
      delete dirtyKeys[k];
      var v = null;
      try { v = localStorage.getItem(k); } catch (e) {}
      var doc = (v === null)
        ? { v: null, updatedAt: t, deleted: true }
        : { v: v, updatedAt: t, deleted: false };
      saveDoc(uid, k).set(doc).then(function () {
        if (v === null) meta.keys[k] = { h: '', t: t, del: true };
        else meta.keys[k] = { h: hashStr(v), t: t, del: false };
        saveMeta();
      }).catch(function () { dirtyKeys[k] = true; /* 次回リトライ */ });
    });
  }

  /* ---------------- フレンド基盤（Firestore） ---------------- */
  function pwf() { return window.PWFriends || null; }
  function localFriends() {
    try {
      var f = JSON.parse(localStorage.getItem('playweb_friends') || '[]');
      return Array.isArray(f) ? f.filter(function (x) { return x && typeof x.code === 'string'; }) : [];
    } catch (e) { return []; }
  }
  function friendsListHash(list) {
    var norm = list.map(function (f) {
      return [f.code, f.name || '', f.uid || '', f.username || ''].join('|');
    }).sort().join(';');
    return hashStr(norm);
  }
  function mergeFriends(local, cloud) {
    var byCode = {};
    (cloud || []).forEach(function (f) { if (f && f.code) byCode[f.code] = f; });
    (local || []).forEach(function (f) {
      if (!f || !f.code) return;
      var c = byCode[f.code];
      if (!c) { byCode[f.code] = f; return; }
      byCode[f.code] = {
        code: f.code,
        name: c.name || f.name || '',
        uid: c.uid || f.uid || '',
        username: c.username || f.username || '',
        addedAt: Math.min(c.addedAt || Infinity, f.addedAt || Infinity)
      };
      if (byCode[f.code].addedAt === Infinity) byCode[f.code].addedAt = Date.now();
      if (!byCode[f.code].uid) delete byCode[f.code].uid;
      if (!byCode[f.code].username) delete byCode[f.code].username;
    });
    return Object.keys(byCode).map(function (k) { return byCode[k]; });
  }
  var applyingFriends = false;
  var lastFriendsHash = '';
  function applyFriendsToLocal(list) {
    var api = pwf();
    applyingFriends = true;
    try {
      if (api && api._cloud && api._cloud.setFriends) api._cloud.setFriends(list);
      else localStorage.setItem('playweb_friends', JSON.stringify(list));
    } catch (e) {}
    applyingFriends = false;
    lastFriendsHash = friendsListHash(list);
    meta.friendsHash = lastFriendsHash;
    saveMeta();
  }
  function uploadFriends() {
    if (!cloudActive() || applyingFriends) return;
    var list = localFriends();
    var h = friendsListHash(list);
    if (h === lastFriendsHash) return;
    lastFriendsHash = h;
    meta.friendsHash = h; saveMeta();
    enrichFriendsWithUid(list).then(function (enriched) {
      var eh = friendsListHash(enriched);
      if (eh !== h) {
        /* uid が付いた分をローカルにも反映してから上げる */
        applyFriendsToLocal(enriched);
        h = eh; lastFriendsHash = eh;
      }
      return friendsDoc(me.uid).set({ list: enriched, updatedAt: nowMs() });
    }).catch(function () { lastFriendsHash = ''; /* 次回リトライ */ });
  }
  /* コードしか分からないフレンドに codes/{code} から uid を引いて付ける */
  var uidByCodeCache = {};
  function lookupUidByCode(code) {
    if (uidByCodeCache[code]) return Promise.resolve(uidByCodeCache[code]);
    return fb.db.doc('codes/' + code).get().then(function (d) {
      var uid = (d.exists && d.data() && d.data().uid) || null;
      if (uid) uidByCodeCache[code] = uid;
      return uid;
    }).catch(function () { return null; });
  }
  function enrichFriendsWithUid(list) {
    var jobs = list.map(function (f) {
      if (f.uid || !f.code) return Promise.resolve(f);
      return lookupUidByCode(f.code).then(function (uid) {
        if (uid) { var nf = {}; for (var k in f) nf[k] = f[k]; nf.uid = uid; return nf; }
        return f;
      });
    });
    return Promise.all(jobs);
  }
  function friendEntryByCode(code) {
    var list = localFriends();
    for (var i = 0; i < list.length; i++) if (list[i].code === code) return list[i];
    return null;
  }
  function resolveUidForCode(code) {
    var f = friendEntryByCode(code);
    if (f && f.uid) return Promise.resolve(f.uid);
    return lookupUidByCode(code);
  }
  function canCloudChat(code) {
    if (!cloudActive()) return false;
    var f = friendEntryByCode(code);
    return !!((f && f.uid) || uidByCodeCache[code]);
  }

  /* プレゼンス購読（フレンドの公開プロフィールを見る） */
  var presenceUnsubs = {};   /* code -> unsub */
  var presenceData = {};     /* code -> {name, game, lastSeen, online} */
  function refreshPresenceWatch() {
    if (!cloudActive()) return;
    var list = localFriends();
    var wanted = {};
    list.forEach(function (f) { if (f.code) wanted[f.code] = true; });
    /* 不要になった購読を解除 */
    Object.keys(presenceUnsubs).forEach(function (code) {
      if (!wanted[code]) { try { presenceUnsubs[code](); } catch (e) {} delete presenceUnsubs[code]; delete presenceData[code]; }
    });
    list.forEach(function (f) {
      if (presenceUnsubs[f.code]) return;
      var code = f.code;
      var start = function (uid) {
        if (!uid || presenceUnsubs[code]) return;
        presenceUnsubs[code] = fb.db.doc('users/' + uid).onSnapshot(function (d) {
          if (!d.exists) return;
          var data = d.data() || {};
          presenceData[code] = {
            name: data.username || '', game: data.currentGame || null,
            lastSeen: data.lastSeen || 0, online: !!data.online
          };
          pushPresence(code);
        }, function () {});
      };
      if (f.uid) start(f.uid);
      else lookupUidByCode(code).then(start);
    });
  }
  function pushPresence(code) {
    var api = pwf();
    if (!api || !api._cloud) return;
    var d = presenceData[code];
    if (!d) return;
    var online = d.online && (nowMs() - (d.lastSeen || 0) < PRESENCE_STALE_MS);
    api._cloud.setPresence(code, { online: online, name: d.name || '', game: d.game });
  }
  function refreshAllPresence() {
    Object.keys(presenceData).forEach(pushPresence);
  }

  /* ---------------- 招待（Firestore） ---------------- */
  var seenInviteIds = {};
  function startInviteListener() {
    var q = fb.db.collection('invites').where('toUid', '==', me.uid);
    var unsub = q.onSnapshot(function (snap) {
      snap.forEach(function (d) {
        var inv = d.data() || {};
        if (inv.status !== 'pending') return;
        if (seenInviteIds[d.id]) return;
        seenInviteIds[d.id] = true;
        if (nowMs() - (inv.ts || 0) > INVITE_TTL_MS) {
          fb.db.doc('invites/' + d.id).set({ status: 'expired' }, { merge: true }).catch(function () {});
          return;
        }
        var api = pwf();
        if (api && api._cloud) {
          api._cloud.receiveInvite({
            from: inv.fromCode, name: inv.fromName || '', game: inv.game,
            room: inv.room, cloudId: d.id
          });
        }
        fb.db.doc('invites/' + d.id).set({ status: 'delivered' }, { merge: true }).catch(function () {});
      });
    }, function () {});
    unsubs.push(unsub);
  }
  function sendInviteCloud(opts) {
    if (!cloudActive()) return Promise.resolve(false);
    return resolveUidForCode(opts.toCode).then(function (uid) {
      if (!uid) return false;
      return fb.db.collection('invites').add({
        toUid: uid, toCode: opts.toCode,
        fromUid: me.uid, fromCode: myFriendCode(), fromName: me.username,
        game: opts.game, room: opts.room, ts: nowMs(), status: 'pending'
      }).then(function () { return true; });
    }).catch(function () { return false; });
  }
  function consumeInvite(id) {
    if (!fb || !id) return;
    fb.db.doc('invites/' + id).set({ status: 'joined' }, { merge: true }).catch(function () {});
  }
  function dismissInvite(id) {
    if (!fb || !id) return;
    fb.db.doc('invites/' + id).set({ status: 'dismissed' }, { merge: true }).catch(function () {});
  }

  /* ---------------- チャット（Firestore） ---------------- */
  var processedMsgIds = {};
  function startChatListener() {
    var q = fb.db.collection('messages').where('participants', 'array-contains', me.uid);
    var unsub = q.onSnapshot(function (snap) {
      var msgs = [];
      snap.forEach(function (d) {
        var m = d.data() || {};
        m._id = d.id;
        msgs.push(m);
      });
      msgs.sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
      var bulk = {};   /* code -> [{f,x,ts}] 既読分の一括取り込み */
      var live = [];   /* 新着（未読扱い） */
      msgs.forEach(function (m) {
        if (processedMsgIds[m._id]) return;
        processedMsgIds[m._id] = true;
        var mine = m.from === me.uid;
        var code = mine ? m.toCode : m.fromCode;
        if (!code) return;
        var seen = meta.chatSeen[code] || 0;
        if ((m.ts || 0) <= seen) {
          (bulk[code] || (bulk[code] = [])).push({ f: mine ? 'me' : 'th', x: m.text || '', ts: m.ts || 0 });
        } else {
          live.push({ code: code, mine: mine, x: m.text || '', ts: m.ts || 0 });
          if ((m.ts || 0) > (meta.chatSeen[code] || 0)) meta.chatSeen[code] = m.ts || 0;
        }
      });
      var api = pwf();
      if (api && api._cloud) {
        Object.keys(bulk).forEach(function (code) { api._cloud.mergeChats(code, bulk[code]); });
        live.forEach(function (m) {
          if (m.mine) api._cloud.mergeChats(m.code, [{ f: 'me', x: m.x, ts: m.ts }]);
          else api._cloud.receiveChat(m.code, { x: m.x, ts: m.ts });
        });
      }
      if (live.length) saveMetaNow();
    }, function () {});
    unsubs.push(unsub);
  }
  function sendChatCloud(code, text) {
    if (!cloudActive()) return Promise.resolve(false);
    return resolveUidForCode(code).then(function (uid) {
      if (!uid) return false;
      var pair = [me.uid, uid].sort();
      return fb.db.collection('messages').add({
        participants: pair, from: me.uid, to: uid,
        fromCode: myFriendCode(), toCode: code,
        text: String(text).slice(0, 500), ts: nowMs()
      }).then(function () { return true; });
    }).catch(function () { return false; });
  }

  /* ---------------- ユーザー名検索・フレンド追加 ---------------- */
  function searchUser(username) {
    if (!cloudActive()) return Promise.resolve(null);
    var v = validateUsername(username);
    if (!v.ok) return Promise.resolve(null);
    var lower = v.name.toLowerCase();
    return fb.db.doc('usernames/' + lower).get().then(function (d) {
      if (!d.exists) return null;
      var uid = (d.data() || {}).uid;
      if (!uid) return null;
      return fb.db.doc('users/' + uid).get().then(function (p) {
        if (!p.exists) return null;
        var data = p.data() || {};
        return { uid: uid, username: data.username || v.name, friendCode: data.friendCode || '' };
      });
    }).catch(function () { return null; });
  }
  function addFriendByUsername(username) {
    if (!cloudActive()) return Promise.resolve({ ok: false, msg: 'ログインが必要です' });
    var v = validateUsername(username);
    if (!v.ok) return Promise.resolve({ ok: false, msg: v.error });
    if (v.name.toLowerCase() === me.usernameLower) return Promise.resolve({ ok: false, msg: 'それはあなた自身のユーザー名です' });
    return searchUser(v.name).then(function (found) {
      if (!found) return { ok: false, msg: 'そのユーザー名の人は見つかりませんでした' };
      if (!found.friendCode) return { ok: false, msg: '相手のフレンド情報がまだ準備できていません（相手のログイン後に有効になります）' };
      var list = localFriends();
      for (var i = 0; i < list.length; i++) {
        if (list[i].code === found.friendCode || list[i].uid === found.uid) {
          return { ok: false, msg: 'すでにフレンドに登録されています' };
        }
      }
      var entry = { code: found.friendCode, name: found.username, uid: found.uid, username: found.username, addedAt: nowMs() };
      var api = pwf();
      if (api && api._cloud && api._cloud.addFriend) api._cloud.addFriend(entry);
      else { list.push(entry); try { localStorage.setItem('playweb_friends', JSON.stringify(list)); } catch (e) {} }
      uidByCodeCache[found.friendCode] = found.uid;
      refreshPresenceWatch();
      return { ok: true, msg: found.username + 'さんをフレンドに追加しました' };
    });
  }

  /* ---------------- プロフィール作成・プレゼンス ---------------- */
  function ensureProfileDocs(uid, username) {
    var lower = username.toLowerCase();
    var code = myFriendCode();
    var jobs = [
      userDoc(uid).set({
        username: username, usernameLower: lower, friendCode: code,
        online: true, lastSeen: nowMs(), currentGame: MY_GAME
      }, { merge: true }),
      fb.db.doc('usernames/' + lower).set({ uid: uid })
    ];
    if (code) jobs.push(fb.db.doc('codes/' + code).set({ uid: uid }));
    return Promise.all(jobs);
  }
  function heartbeat() {
    if (!cloudActive()) return;
    userDoc(me.uid).set({
      online: true, lastSeen: nowMs(), currentGame: MY_GAME,
      username: me.username, usernameLower: me.usernameLower, friendCode: myFriendCode()
    }, { merge: true }).catch(function () {});
    refreshAllPresence();
  }
  function setOffline() {
    if (!me || !fb) return;
    try {
      userDoc(me.uid).set({ online: false, lastSeen: nowMs() }, { merge: true }).catch(function () {});
    } catch (e) {}
  }

  /* ---------------- サービス開始・停止 ---------------- */
  function startServices() {
    if (!me || servicesOn) return;
    servicesOn = true;
    updatePill(); updateModal(); updateSearchRow();
    syncSaves();
    /* フレンド一覧: クラウドとマージしてから購読 */
    friendsDoc(me.uid).get().then(function (d) {
      var cloudList = (d.exists && d.data() && Array.isArray(d.data().list)) ? d.data().list : [];
      var merged = mergeFriends(localFriends(), cloudList);
      applyFriendsToLocal(merged);
      if (friendsListHash(merged) !== friendsListHash(cloudList)) {
        /* マージ結果がクラウドと違う場合は直接書き戻す（uploadFriends は
           lastFriendsHash が適用済みのため早期returnしてしまう） */
        friendsDoc(me.uid).set({ list: merged, updatedAt: nowMs() }).catch(function () {});
      }
      refreshPresenceWatch();
    }).catch(function () { refreshPresenceWatch(); });
    var fu = friendsDoc(me.uid).onSnapshot(function (d) {
      if (!d.exists) return;
      var cloudList = (d.data() && Array.isArray(d.data().list)) ? d.data().list : [];
      if (friendsListHash(cloudList) === lastFriendsHash) return;
      var merged = mergeFriends(localFriends(), cloudList);
      applyFriendsToLocal(merged);
      refreshPresenceWatch();
    }, function () {});
    unsubs.push(fu);
    startInviteListener();
    startChatListener();
    heartbeat();
    timers.push(setInterval(heartbeat, HEARTBEAT_MS));
    timers.push(setInterval(function () { uploadDirty(); }, 15000));
  }
  function stopServices() {
    servicesOn = false;
    unsubs.forEach(function (u) { try { u(); } catch (e) {} });
    unsubs = [];
    timers.forEach(function (t) { clearInterval(t); });
    timers = [];
    Object.keys(presenceUnsubs).forEach(function (code) {
      try { presenceUnsubs[code](); } catch (e) {}
    });
    presenceUnsubs = {}; presenceData = {};
    var api = pwf();
    if (api && api._cloud) api._cloud.clearPresence();
    updatePill(); updateModal(); updateSearchRow();
  }
  var lastPullAt = 0;
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && cloudActive() && nowMs() - lastPullAt > 30000) {
      lastPullAt = nowMs();
      syncSaves();
    }
  });
  window.addEventListener('beforeunload', function () {
    uploadDirty();
    saveMetaNow();
    if (cloudActive()) setOffline();
  });
  window.addEventListener('pagehide', function () { if (cloudActive()) setOffline(); });

  /* ---------------- 認証アクション ---------------- */
  function doSignup(username, password) {
    var v = validateUsername(username);
    if (!v.ok) return Promise.resolve({ ok: false, msg: v.error });
    var pv = validatePassword(password);
    if (!pv.ok) return Promise.resolve({ ok: false, msg: pv.error });
    if (!fb) return Promise.resolve({ ok: false, msg: 'ログイン機能を読み込めませんでした' });
    var name = v.name, lower = name.toLowerCase();
    return fb.db.doc('usernames/' + lower).get().then(function (d) {
      if (d.exists) return { ok: false, msg: 'このユーザー名は既に使われています' };
      pendingUsername = name;
      return fb.auth.createUserWithEmailAndPassword(usernameToEmail(name), password).then(function (cred) {
        var uid = cred.user.uid;
        return ensureProfileDocs(uid, name).then(function () {
          return { ok: true, msg: 'アカウントを作成しました' };
        }).catch(function () {
          /* ユーザー名の確保に競合で負けた等: 作った認証ユーザーを消して巻き戻す */
          try { cred.user.delete().catch(function () {}); } catch (e) {}
          pendingUsername = null;
          return { ok: false, msg: 'このユーザー名は既に使われています' };
        });
      });
    }).catch(function (e) {
      pendingUsername = null;
      return { ok: false, msg: authErrorMessage(e) };
    });
  }
  function doLogin(username, password) {
    var v = validateUsername(username);
    if (!v.ok) return Promise.resolve({ ok: false, msg: v.error });
    if (!fb) return Promise.resolve({ ok: false, msg: 'ログイン機能を読み込めませんでした' });
    return fb.auth.signInWithEmailAndPassword(usernameToEmail(v.name), password)
      .then(function () { return { ok: true, msg: 'ログインしました' }; })
      .catch(function (e) { return { ok: false, msg: authErrorMessage(e) }; });
  }
  function doLogout() {
    if (!fb) return Promise.resolve();
    setOffline();
    stopServices();
    me = null;
    return fb.auth.signOut().catch(function () {}).then(function () {
      updatePill(); updateModal(); updateSearchRow();
    });
  }
  function onAuthUser(user) {
    if (!user) {
      if (me) { stopServices(); me = null; }
      updatePill(); updateModal(); updateSearchRow();
      return;
    }
    var uid = user.uid;
    userDoc(uid).get().then(function (d) {
      var username;
      if (d.exists && d.data() && d.data().username) {
        username = d.data().username;
      } else if (pendingUsername) {
        username = pendingUsername;
      } else {
        username = (user.email || '').split('@')[0] || 'player';
      }
      pendingUsername = null;
      me = { uid: uid, username: username, usernameLower: username.toLowerCase() };
      /* 公開プロフィール（フレンドコード・在席）を最新化してからサービス開始 */
      ensureProfileDocs(uid, username).catch(function () {}).then(function () {
        startServices();
      });
    }).catch(function () {
      /* プロフィール取得に失敗しても最低限ログイン状態にはする */
      var name = pendingUsername || (user.email || '').split('@')[0] || 'player';
      pendingUsername = null;
      me = { uid: uid, username: name, usernameLower: name.toLowerCase() };
      startServices();
    });
  }

  /* ---------------- UI（ピルボタン＋モーダル） ---------------- */
  var CSS = [
    '.pwa-pill{position:fixed;left:12px;bottom:12px;z-index:99990;background:rgba(13,16,32,.78);border:1px solid rgba(255,255,255,.25);color:#eef0ff;border-radius:999px;padding:7px 13px;font-size:12.5px;font-weight:800;cursor:pointer;font-family:"Hiragino Kaku Gothic ProN","Noto Sans JP",system-ui,sans-serif;backdrop-filter:blur(6px);box-shadow:0 6px 18px rgba(0,0,0,.35);max-width:44vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.pwa-pill:active{transform:translateY(1px)}',
    '.pwa-overlay{position:fixed;inset:0;z-index:100004;background:rgba(3,4,12,.62);display:none;align-items:center;justify-content:center;padding:14px;font-family:"Hiragino Kaku Gothic ProN","Noto Sans JP",system-ui,sans-serif}',
    '.pwa-overlay.show{display:flex}',
    '.pwa-modal{background:#0d1020;width:min(380px,94vw);max-height:86vh;overflow-y:auto;border-radius:16px;padding:18px;box-shadow:0 20px 50px rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.12);color:#eef0ff}',
    '.pwa-head{display:flex;align-items:center;justify-content:space-between;font-size:16px;font-weight:900;margin-bottom:6px}',
    '.pwa-x{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);color:#eef0ff;width:32px;height:32px;border-radius:50%;font-size:14px;cursor:pointer}',
    '.pwa-tabs{display:flex;gap:8px;margin:10px 0 12px}',
    '.pwa-tab{flex:1;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.14);color:#9aa1c0;border-radius:10px;padding:9px;font-size:13.5px;font-weight:800;cursor:pointer;font-family:inherit}',
    '.pwa-tab.on{background:linear-gradient(90deg,#0891b2,#7c3aed);color:#fff;border-color:transparent}',
    '.pwa-input{width:100%;box-sizing:border-box;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.16);border-radius:10px;color:#fff;padding:10px 11px;font-size:14px;font-family:inherit;outline:none;margin-bottom:9px}',
    '.pwa-input:focus{border-color:#22d3ee}',
    '.pwa-btn{width:100%;background:linear-gradient(90deg,#0891b2,#7c3aed);border:none;color:#fff;border-radius:10px;padding:11px 13px;font-size:14px;font-weight:900;cursor:pointer;font-family:inherit}',
    '.pwa-btn:disabled{opacity:.5;cursor:wait}',
    '.pwa-btn.sub{background:rgba(255,255,255,.09);border:1px solid rgba(255,255,255,.16);color:#eef0ff}',
    '.pwa-note{font-size:11.5px;color:#9aa1c0;margin-top:8px;line-height:1.6}',
    '.pwa-note.err{color:#fca5a5}',
    '.pwa-note.ok{color:#86efac}',
    '.pwa-user{font-size:19px;font-weight:900;color:#fde68a;margin:4px 0 2px}',
    '@media (max-width:480px){ .pwa-pill{bottom:12px;left:12px} }'
  ].join('\n');
  var pillEl = null, overlayEl = null;
  function buildUI() {
    if (pillEl) return;
    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    pillEl = document.createElement('button');
    pillEl.className = 'pwa-pill';
    pillEl.id = 'pwaPill';
    pillEl.textContent = '👤 ログイン';
    pillEl.onclick = openModal;
    document.body.appendChild(pillEl);

    overlayEl = document.createElement('div');
    overlayEl.className = 'pwa-overlay';
    overlayEl.innerHTML =
      '<div class="pwa-modal">' +
      '<div class="pwa-head"><span>👤 PlayWebアカウント</span>' +
      '<button class="pwa-x" id="pwaClose" aria-label="閉じる">✕</button></div>' +
      '<div id="pwaBody"></div>' +
      '</div>';
    document.body.appendChild(overlayEl);
    overlayEl.addEventListener('click', function (e) { if (e.target === overlayEl) closeModal(); });
    overlayEl.querySelector('#pwaClose').onclick = closeModal;
    updatePill(); updateModal();
  }
  function updatePill() {
    if (!pillEl) return;
    pillEl.textContent = me ? ('👤 ' + me.username) : '👤 ログイン';
  }
  function setStatus(t) {
    statusText = t;
    var el = $('pwaStatus');
    if (el) el.textContent = t;
  }
  function updateModal() {
    var body = $('pwaBody');
    if (!body) return;
    if (sdkState === 'loading') {
      body.innerHTML = '<div class="pwa-note">読み込み中…</div>';
      return;
    }
    if (sdkState === 'unavailable' || !fb) {
      body.innerHTML = '<div class="pwa-note err">ログイン機能を読み込めませんでした（通信環境を確認してください）。アカウントなしでも、今まで通りゲームとフレンド機能は使えます。</div>';
      return;
    }
    if (me) {
      body.innerHTML =
        '<div class="pwa-note">ログイン中</div>' +
        '<div class="pwa-user">' + esc(me.username) + '</div>' +
        '<div class="pwa-note" id="pwaStatus">' + esc(statusText || 'クラウドセーブ有効') + '</div>' +
        '<div class="pwa-note">セーブデータ・フレンド・戦績はクラウドに同期されます。別の端末で同じアカウントにログインすると続きが遊べます。</div>' +
        '<button class="pwa-btn sub" id="pwaLogout" style="margin-top:12px">ログアウト</button>' +
        '<div class="pwa-note">ログアウトしても、この端末のセーブデータは残ります。</div>';
      $('pwaLogout').onclick = function () { doLogout(); };
      return;
    }
    body.innerHTML =
      '<div class="pwa-tabs">' +
      '<button class="pwa-tab' + (modalMode === 'login' ? ' on' : '') + '" id="pwaTabLogin">ログイン</button>' +
      '<button class="pwa-tab' + (modalMode === 'signup' ? ' on' : '') + '" id="pwaTabSignup">新規登録</button></div>' +
      '<input class="pwa-input" id="pwaUser" maxlength="16" placeholder="ユーザー名（半角英数字・_・- で3〜16文字）" autocomplete="username" autocapitalize="none">' +
      '<input class="pwa-input" id="pwaPass" type="password" maxlength="64" placeholder="パスワード（6文字以上）" autocomplete="' + (modalMode === 'signup' ? 'new-password' : 'current-password') + '">' +
      '<button class="pwa-btn" id="pwaSubmit">' + (modalMode === 'signup' ? 'アカウントを作成' : 'ログイン') + '</button>' +
      '<div class="pwa-note" id="pwaMsg"></div>' +
      '<div class="pwa-note">ログインすると、セーブデータ・フレンド・戦績がクラウドに保存され、別の端末でも続きが遊べます。フレンド追加はユーザー名検索でもできるようになります。</div>';
    $('pwaTabLogin').onclick = function () { modalMode = 'login'; updateModal(); };
    $('pwaTabSignup').onclick = function () { modalMode = 'signup'; updateModal(); };
    var submit = function () {
      var u = $('pwaUser').value, p = $('pwaPass').value;
      var btn = $('pwaSubmit'), msg = $('pwaMsg');
      btn.disabled = true; msg.textContent = '処理中…'; msg.className = 'pwa-note';
      var job = modalMode === 'signup' ? doSignup(u, p) : doLogin(u, p);
      job.then(function (r) {
        btn.disabled = false;
        if (r.ok) { msg.textContent = r.msg; msg.className = 'pwa-note ok'; }
        else { msg.textContent = r.msg; msg.className = 'pwa-note err'; }
      });
    };
    $('pwaSubmit').onclick = submit;
    $('pwaPass').addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
  }
  function openModal() {
    buildUI();
    overlayEl.classList.add('show');
    updateModal();
  }
  function closeModal() {
    if (overlayEl) overlayEl.classList.remove('show');
  }
  /* フレンドパネル内の「ユーザー名で追加」行の表示切替とイベント結線（friends.js 側に器がある） */
  var searchBound = false;
  function updateSearchRow() {
    var sec = $('pwfSearchSec');
    if (sec) sec.style.display = cloudActive() ? '' : 'none';
    var note = $('pwfFootNote');
    if (note && cloudActive()) {
      note.textContent = 'ログイン中はフレンドの在席・招待・メッセージがクラウド経由で届きます（相手がオフラインでも送れます）。対戦は従来どおり直接つながります。';
    }
    if (searchBound) return;
    var btn = $('pwfSearchBtn');
    if (!btn) return;
    searchBound = true;
    btn.onclick = function () {
      var input = $('pwfSearchName'), n = $('pwfSearchNote');
      var name = input.value.trim();
      n.classList.remove('err');
      btn.disabled = true; n.textContent = '検索中…';
      addFriendByUsername(name).then(function (r) {
        btn.disabled = false;
        n.textContent = r.msg;
        if (!r.ok) n.classList.add('err');
        if (r.ok) input.value = '';
      });
    };
    $('pwfSearchName').addEventListener('keydown', function (e) { if (e.key === 'Enter') btn.click(); });
  }
  /* パネルは friends.js が遅れて作る場合があるので、しばらくポーリングして結線する */
  (function bindSearchWhenReady() {
    var tries = 0;
    (function tick() {
      updateSearchRow();
      if (!searchBound && ++tries <= 20) setTimeout(tick, 500);
    })();
  })();

  /* ---------------- SDK ロード ---------------- */
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('load failed: ' + src)); };
      document.head.appendChild(s);
    });
  }
  function sdkReady() {
    return !!(window.firebase && window.firebase.auth && window.firebase.firestore &&
      typeof window.firebase.initializeApp === 'function');
  }
  function initFirebase() {
    if (sdkReady()) return Promise.resolve(true);
    var chain = Promise.resolve();
    ['firebase-app-compat.js', 'firebase-auth-compat.js', 'firebase-firestore-compat.js'].forEach(function (f) {
      chain = chain.then(function () { return loadScript(SDK_BASE + f); });
    });
    var timeout = new Promise(function (_, reject) {
      setTimeout(function () { reject(new Error('sdk timeout')); }, 20000);
    });
    return Promise.race([chain, timeout]).then(function () { return sdkReady(); });
  }
  function startAuth() {
    try {
      var app;
      try { app = window.firebase.initializeApp(FIREBASE_CONFIG); }
      catch (e) { app = window.firebase.app(); }
      var auth = window.firebase.auth();
      var db = window.firebase.firestore();
      fb = { auth: auth, db: db, app: app };
      var persist = auth.setPersistence(window.firebase.auth.Auth.Persistence.LOCAL);
      if (persist && persist.catch) persist.catch(function () {});
      sdkState = 'ready';
      auth.onAuthStateChanged(onAuthUser);
    } catch (e) {
      fb = null;
      sdkState = 'unavailable';
    }
    updatePill(); updateModal(); updateSearchRow();
  }

  /* ---------------- 公開 API ---------------- */
  window.PWAccount = {
    version: 1,
    config: FIREBASE_CONFIG,
    validateUsername: validateUsername,
    usernameToEmail: usernameToEmail,
    user: function () { return me ? { uid: me.uid, username: me.username } : null; },
    cloudActive: cloudActive,
    sdkState: function () { return sdkState; },
    login: doLogin,
    signup: doSignup,
    logout: doLogout,
    openModal: openModal,
    closeModal: closeModal,
    syncNow: function () { return syncSaves(); },
    searchUser: searchUser,
    addFriendByUsername: addFriendByUsername,
    sendInviteCloud: sendInviteCloud,
    sendChatCloud: sendChatCloud,
    canCloudChat: canCloudChat,
    consumeInvite: consumeInvite,
    dismissInvite: dismissInvite,
    /* テスト用フック */
    _test: {
      syncableKey: syncableKey,
      collectLocal: collectLocal,
      hashStr: hashStr,
      mergeFriends: mergeFriends,
      friendsListHash: friendsListHash,
      meta: function () { return meta; },
      dirtyKeys: function () { return dirtyKeys; }
    }
  };

  /* ---------------- 初期化 ---------------- */
  function init() {
    buildUI();
    initFirebase().then(function (ok) {
      if (ok) startAuth();
      else { sdkState = 'unavailable'; updatePill(); updateModal(); }
    }).catch(function () {
      sdkState = 'unavailable';
      updatePill(); updateModal();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
