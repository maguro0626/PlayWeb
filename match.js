/* ============================================================
   PlayWeb Firestore マッチ基盤（match.js / v55〜）
   ------------------------------------------------------------
   ターン制ゲームのオンライン対戦を PeerJS から Firestore の
   マッチドキュメント（matches/{code}）へ移行するための共通基盤。

   設計:
   - マッチID = 従来のルームコードと同じ6文字コード
     （ABCDEFGHJKLMNPQRSTUVWXYZ23456789 から生成）。
     friends.js の招待フロー（room 検証・?join= 遷移・コード検出）が
     そのまま使えるよう、ID 形式をルームコードに合わせている。
   - ドキュメント構造（matches/{code}）:
       game      : ゲームID（'reversi' 等）
       hostUid / hostName   : ホスト
       guestUid / guestName : ゲスト（参加前は ''）
       players   : [uid, ...]（ルールの当事者判定と findActive の検索用）
       state     : 対局状態（ゲーム固有の JSON 化可能なオブジェクト。
                   盤面の正はここに置く）
       turn      : 現在の手番の uid（state とは別に持つ・参照用）
       lastMove  : 直前の着手情報（ゲーム固有・任意）
       lastAction: 直前の state 書き込みの種別（ゲーム固有・任意）
       seq       : state の版数（publish のたびに +1）
       round     : 再戦のたびに +1 する局数カウンタ
       msg / msgFrom / msgAt : 汎用メッセージ中継（投了・再戦申込など。
                   state に載らない一回きりの通知用）
       status    : 'waiting' | 'playing' | 'finished'
       winner    : 勝者 uid | 'draw' | null
       createdAt / updatedAt : ミリ秒
   - 手の送信 = publish（state 書き込み）。相手側は attach の
     onSnapshot で即時に受け取る。接続という概念がないため、
     招待の受け手が遅れて来ても、ページを開き直しても、
     findActive / attach で進行中マッチへ復帰できる。
   - 認証と Firebase の初期化は account.js が担う。本モジュールは
     window.firebase（compat SDK）と PWAccount.user() /
     PWAccount.cloudActive() を通して状態を参照するだけ。

   公開 API: window.PWMatch
     available()            その場でマッチ機能が使えるか
     whenReady(timeoutMs)   使えるようになるまで待つ Promise<boolean>
     me()                   {uid, username} | null
     create(game, fields)   マッチ作成 → Promise<{code}>
                            fields には state 等のゲーム固有初期値を渡す
     join(code)             参加 → Promise<data|null>（無ければ null）
     get(code)              現在のドキュメント → Promise<data|null>
     attach(code, cb)       購読開始。cb(data|null, code)。戻り値は解除関数
     detach(code)           attach の解除（attach の戻り値でも解除可）
     publish(code, patch)   state 系の書き込み（seq を自動で +1 し、
                            lastWriter に自分を記録する）
     sendMsg(code, msg)     msg 中継の書き込み
     update(code, patch)    その他のフィールド更新（status 等）
     finish(code, winner)   終局を記録（status='finished', winner）
     findActive(game)       自分が参加中の進行マッチを1件返す
                            → Promise<{code, data}|null>
     close(code)            購読解除＋再開ヒントの掃除（ドキュメントは残す）
   ============================================================ */
(function () {
  'use strict';
  if (window.__pwMatchLoaded) return;
  window.__pwMatchLoaded = true;

  var COL = 'matches';
  var CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; /* I,O,0,1 を除外（friends.js の ROOM_RE と一致） */
  var STALE_MS = 24 * 60 * 60 * 1000;  /* findActive でこれより古い対局は無視する */
  var LS_LAST_PREFIX = 'pwmatch_last_';

  function db() {
    try {
      if (window.firebase && typeof window.firebase.firestore === 'function') {
        return window.firebase.firestore();
      }
    } catch (e) {}
    return null;
  }
  function me() {
    try {
      var u = window.PWAccount && window.PWAccount.user && window.PWAccount.user();
      return (u && typeof u.uid === 'string' && u.uid) ? u : null;
    } catch (e) { return null; }
  }
  function available() {
    try {
      return !!(db() && me() && window.PWAccount &&
        typeof window.PWAccount.cloudActive === 'function' && window.PWAccount.cloudActive());
    } catch (e) { return false; }
  }
  function whenReady(timeoutMs) {
    var limit = typeof timeoutMs === 'number' ? timeoutMs : 15000;
    return new Promise(function (resolve) {
      if (available()) return resolve(true);
      var t0 = Date.now();
      (function tick() {
        if (available()) return resolve(true);
        if (Date.now() - t0 > limit) return resolve(false);
        setTimeout(tick, 250);
      })();
    });
  }
  function genCode() {
    var s = '';
    for (var i = 0; i < 6; i++) s += CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0];
    return s;
  }
  function ref(code) { return db().collection(COL).doc(code); }
  function rememberLast(game, code) {
    try { localStorage.setItem(LS_LAST_PREFIX + game, code); } catch (e) {}
  }
  function forgetLast(game, code) {
    try {
      if (localStorage.getItem(LS_LAST_PREFIX + game) === code) {
        localStorage.removeItem(LS_LAST_PREFIX + game);
      }
    } catch (e) {}
  }

  /* code -> {data, unsub} の購読キャッシュ（最新データの保持と seq 管理に使う） */
  var subs = {};

  function create(game, fields) {
    var u = me();
    var d = db();
    if (!u || !d) return Promise.reject(new Error('pwmatch/unavailable'));
    var base = {};
    if (fields && typeof fields === 'object') {
      Object.keys(fields).forEach(function (k) { base[k] = fields[k]; });
    }
    /* 予約キーは基盤側が必ず上書きする（ゲーム側の fields では変えられない） */
    base.game = game;
    base.hostUid = u.uid;
    base.hostName = u.username || '';
    base.guestUid = '';
    base.guestName = '';
    base.players = [u.uid];
    base.status = 'waiting';
    base.seq = 0;
    base.round = 1;
    base.winner = null;
    base.msg = null;
    base.msgFrom = '';
    base.msgAt = 0;
    base.lastWriter = u.uid;
    base.createdAt = Date.now();
    base.updatedAt = Date.now();
    if (!('state' in base)) base.state = null;
    if (!('turn' in base)) base.turn = '';
    if (!('lastMove' in base)) base.lastMove = null;
    if (!('lastAction' in base)) base.lastAction = null;

    var tries = 0;
    function attempt() {
      var code = genCode();
      return ref(code).set(base).then(function () {
        subs[code] = { data: base, unsub: null };
        rememberLast(game, code);
        return { code: code };
      }).catch(function (e) {
        /* コード衝突（既存ドキュメントへの update 扱いでルール拒否）等は引き直す */
        if (++tries < 5) return attempt();
        throw e;
      });
    }
    return attempt();
  }

  function get(code) {
    if (!db()) return Promise.resolve(null);
    return ref(code).get().then(function (snap) {
      return snap && snap.exists ? snap.data() : null;
    }).catch(function () { return null; });
  }

  function join(code) {
    var u = me();
    if (!u || !db()) return Promise.reject(new Error('pwmatch/unavailable'));
    return get(code).then(function (data) {
      if (!data) return null;
      if (data.guestUid === u.uid || data.hostUid === u.uid) {
        /* 既に参加済み（再開） */
        subs[code] = { data: data, unsub: (subs[code] || {}).unsub || null };
        rememberLast(data.game, code);
        return data;
      }
      if (data.status === 'finished') return data; /* 終了済みは参加で上書きしない（可否はゲーム側が判断） */
      if (data.guestUid) return null; /* 満席 */
      var patch = {
        guestUid: u.uid,
        guestName: u.username || '',
        players: [data.hostUid, u.uid],
        status: 'playing',
        lastWriter: u.uid,
        updatedAt: Date.now()
      };
      return ref(code).update(patch).then(function () {
        var merged = {};
        Object.keys(data).forEach(function (k) { merged[k] = data[k]; });
        Object.keys(patch).forEach(function (k) { merged[k] = patch[k]; });
        subs[code] = { data: merged, unsub: (subs[code] || {}).unsub || null };
        rememberLast(data.game, code);
        return merged;
      });
    });
  }

  function attach(code, cb) {
    if (!db()) return function () {};
    var unsub = ref(code).onSnapshot(function (snap) {
      var data = snap && snap.exists ? snap.data() : null;
      var cur = subs[code] || (subs[code] = { data: null, unsub: null });
      cur.data = data;
      try { cb(data, code); } catch (e) {}
    }, function () {});
    var cur = subs[code] || (subs[code] = { data: null, unsub: null });
    cur.unsub = unsub;
    return function () { detach(code); };
  }
  function detach(code) {
    var cur = subs[code];
    if (cur && cur.unsub) { try { cur.unsub(); } catch (e) {} cur.unsub = null; }
  }

  function update(code, patch) {
    if (!db()) return Promise.reject(new Error('pwmatch/unavailable'));
    var p = {};
    if (patch) Object.keys(patch).forEach(function (k) { p[k] = patch[k]; });
    p.updatedAt = Date.now();
    return ref(code).update(p).then(function () {
      var cur = subs[code];
      if (cur && cur.data) {
        Object.keys(p).forEach(function (k) { cur.data[k] = p[k]; });
      }
    });
  }

  /* state 系の書き込み。seq を購読キャッシュ基準で +1 し、lastWriter を付ける */
  function publish(code, patch) {
    var u = me();
    var cur = subs[code];
    var baseSeq = cur && cur.data && typeof cur.data.seq === 'number' ? cur.data.seq : 0;
    var p = {};
    if (patch) Object.keys(patch).forEach(function (k) { p[k] = patch[k]; });
    p.seq = baseSeq + 1;
    if (u) p.lastWriter = u.uid;
    return update(code, p);
  }

  function sendMsg(code, msg) {
    var u = me();
    return update(code, {
      msg: msg || null,
      msgFrom: u ? u.uid : '',
      msgAt: Date.now(),
      lastWriter: u ? u.uid : ''
    });
  }

  function finish(code, winner) {
    return update(code, { status: 'finished', winner: winner == null ? null : winner });
  }

  function findActive(game) {
    var u = me();
    if (!u || !db()) return Promise.resolve(null);
    return db().collection(COL).where('players', 'array-contains', u.uid).get()
      .then(function (snap) {
        var best = null;
        snap.forEach(function (docSnap) {
          var data = docSnap.data();
          if (!data || data.game !== game) return;
          if (data.status !== 'waiting' && data.status !== 'playing') return;
          if (Date.now() - (data.updatedAt || 0) > STALE_MS) return;
          var score = (data.status === 'playing' ? 2 : 1) * 1e15 + (data.updatedAt || 0);
          if (!best || score > best.score) best = { code: docSnap.id, data: data, score: score };
        });
        return best ? { code: best.code, data: best.data } : null;
      }).catch(function () { return null; });
  }

  function close(code) {
    detach(code);
    var cur = subs[code];
    if (cur && cur.data && cur.data.game) forgetLast(cur.data.game, code);
    delete subs[code];
  }

  window.PWMatch = {
    version: 1,
    available: available,
    whenReady: whenReady,
    me: me,
    create: create,
    join: join,
    get: get,
    attach: attach,
    detach: detach,
    update: update,
    publish: publish,
    sendMsg: sendMsg,
    finish: finish,
    findActive: findActive,
    close: close,
    /* テスト用フック */
    _test: {
      genCode: genCode,
      subs: function () { return subs; }
    }
  };
})();
