/* ============================================================
   PlayWeb フレンド機能（friends.js）
   ------------------------------------------------------------
   サーバーなし・PeerJS（P2P）だけで動く共通モジュール。
   - プロフィール: localStorage 'playweb_profile' {name, code}
       code は8文字（I,O,0,1 除外）。PeerID は 'playweb-u-<code>'。
   - フレンド: localStorage 'playweb_friends' [{code, name, addedAt}]
   - チャット履歴: localStorage 'playweb_chats' {code: [{f,x,ts}]}（最大200件/人）
   - 未読: localStorage 'playweb_unread' {code: n}
   - ボタン位置: localStorage 'playweb_fabpos' {edge:'left'|'right', bottom}
       フローティングボタンはドラッグで左右の画面端へ移動でき、位置を全ページで共有。
       操作がなければ数秒で控えめ表示（半透明・縮小）になるが、バッジは見えたまま。
   メッセージ種別: hello / ping / pong / chat / invite / bye
   各ページは読み込み前に次を設定する:
     window.PW_GAME = 'survivors' など（ポータルは 'portal'）
     window.PW_JOIN_CFG = {openers, input, joinBtn|joinCall, hostBtn}（任意）
   テスト用に window.PW_FRIENDS_PEER_OPTS があれば Peer の接続先を差し替える。
   このファイルが読み込めない/PeerJS が無い環境でもゲーム単体は従来どおり動く。
   ============================================================ */
(function () {
  'use strict';
  if (window.__pwFriendsLoaded) return;
  window.__pwFriendsLoaded = true;

  /* ---------------- 定数 ---------------- */
  var CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; /* I,O,0,1 を除外 */
  var PEER_PREFIX = 'playweb-u-';
  var LS_PROFILE = 'playweb_profile', LS_FRIENDS = 'playweb_friends',
      LS_CHATS = 'playweb_chats', LS_UNREAD = 'playweb_unread',
      LS_FABPOS = 'playweb_fabpos';
  var GAMES = {
    portal:     { title: 'ポータル',               file: 'index.html' },
    tetris:     { title: 'テトリス',               file: 'tetris.html' },
    suica:      { title: 'スイカゲーム',           file: 'suica.html' },
    crepe:      { title: 'クレープ工房',           file: 'crepe.html' },
    survivors:  { title: 'まじょねこサバイバーズ', file: 'survivors.html' },
    blockblast: { title: 'ブロックブラスト',       file: 'blockblast.html' },
    minesweeper:{ title: 'マインスイーパ',         file: 'minesweeper.html' },
    reversi:    { title: 'オセロ',                 file: 'reversi.html' },
    shogi:      { title: '将棋',                   file: 'shogi.html' },
    majan:      { title: '麻雀',                   file: 'majan.html' },
    daihugou:   { title: '大富豪',                 file: 'daihugou.html' },
    hanahuda:   { title: '花札',                   file: 'hanahuda.html' },
    uno:        { title: 'UNO',                    file: 'uno.html' },
    blockzushi: { title: 'ブロック崩し',           file: 'blockzushi.html' },
    jump:       { title: 'ジャンプラン',           file: 'jump.html' },
    caring:     { title: '育成ゲーム',             file: 'caring.html' },
    gamedev:    { title: 'ゲーム工房物語',         file: 'gamedev.html' },
    rpg:        { title: 'モンスターライズ',       file: 'rpg.html' },
    otome:      { title: '乙女ゲーム',             file: 'otome.html' }
  };
  var GAME_ORDER = ['tetris','suica','crepe','survivors','blockblast','minesweeper','reversi','shogi','majan','daihugou','hanahuda','uno','blockzushi','jump','caring','gamedev','rpg','otome'];
  var PEER_OPTS = { config: { iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
  ] } };
  /* 部屋コード表示要素の候補（ゲーム横断で探す） */
  var ROOM_CODE_SELS = ['#roomCodeText', '#bbRoomCode', '#vsRoomCode', '#online-code',
    '#net-lobby-code', '#net-room-code', '#lobby-code', '#net-code-text', '#vs-code',
    '#ov-room-code', '.room-code'];
  var ROOM_RE = /^[A-HJ-NP-Z2-9]{6}$/;

  function inferGame() {
    var f = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
    if (f === '' || f === 'index.html') return 'portal';
    var id = f.replace(/\.html$/, '');
    return GAMES[id] ? id : 'portal';
  }
  var MY_GAME = (typeof window.PW_GAME === 'string' && GAMES[window.PW_GAME]) ? window.PW_GAME : inferGame();

  /* ---------------- 保存データ ---------------- */
  function lsGet(key, fallback) {
    try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
    catch (e) { return fallback; }
  }
  function lsSet(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }
  function genCode(n) {
    var s = '';
    for (var i = 0; i < n; i++) s += CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0];
    return s;
  }
  function loadProfile() {
    var p = lsGet(LS_PROFILE, null);
    if (!p || typeof p.code !== 'string' || !/^[A-HJ-NP-Z2-9]{8}$/.test(p.code)) {
      p = { name: '', code: genCode(8) };
      lsSet(LS_PROFILE, p);
    }
    if (typeof p.name !== 'string') p.name = '';
    return p;
  }
  var profile = loadProfile();
  var friends = lsGet(LS_FRIENDS, []);
  if (!Array.isArray(friends)) friends = [];
  friends = friends.filter(function (f) { return f && typeof f.code === 'string'; });
  var chats = lsGet(LS_CHATS, {});
  if (!chats || typeof chats !== 'object') chats = {};
  var unread = lsGet(LS_UNREAD, {});
  if (!unread || typeof unread !== 'object') unread = {};

  function saveProfile() { lsSet(LS_PROFILE, profile); }
  function saveFriends() { lsSet(LS_FRIENDS, friends); }
  function saveChats() { lsSet(LS_CHATS, chats); }
  function saveUnread() { lsSet(LS_UNREAD, unread); }
  function myName() { return (profile.name || '').trim() || 'プレイヤー'; }
  function friendOf(code) {
    for (var i = 0; i < friends.length; i++) if (friends[i].code === code) return friends[i];
    return null;
  }
  function cleanCode(s) {
    return (s || '').toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, '').slice(0, 8);
  }

  /* ---------------- 状態 ---------------- */
  var state = {
    peer: null, peerOpen: false, unavailable: false, idTaken: false,
    conns: {},        /* code -> {conn, open, lastSeen} */
    presence: {},     /* code -> {online, name, game} */
    invites: [],      /* {from, name, game, room, ts} */
    view: 'list',     /* list | chat | pick */
    chatWith: null, pickFor: null,
    panelOpen: false
  };
  function isOnline(code) {
    var p = state.presence[code];
    return !!(p && p.online);
  }
  function presenceText(code) {
    var p = state.presence[code];
    if (!p || !p.online) return 'オフライン';
    if (p.game && GAMES[p.game]) {
      return p.game === 'portal' ? 'オンライン・ポータル' : 'オンライン・' + GAMES[p.game].title + 'でプレイ中';
    }
    return 'オンライン';
  }
  function displayName(code) {
    var p = state.presence[code];
    if (p && p.name) return p.name;
    var f = friendOf(code);
    return (f && f.name) || 'フレンド';
  }

  /* ---------------- Peer / プレゼンス ---------------- */
  function peerOpts() { return window.PW_FRIENDS_PEER_OPTS || PEER_OPTS; }
  function startPeer() {
    if (typeof window.Peer === 'undefined') { state.unavailable = true; renderAll(); return; }
    try { state.peer = new Peer(PEER_PREFIX + profile.code, peerOpts()); }
    catch (e) { state.unavailable = true; renderAll(); return; }
    var peer = state.peer;
    peer.on('open', function () {
      state.peerOpen = true; state.idTaken = false;
      friends.forEach(function (f) { connectTo(f.code); });
      renderAll();
    });
    peer.on('connection', function (c) {
      var code = (c.peer || '').replace(PEER_PREFIX, '');
      if (!friendOf(code)) { /* 知らない相手からの接続は受け付けない */
        c.on('open', function () { try { c.close(); } catch (e) {} });
        return;
      }
      wireConn(c, code, 'in');
    });
    peer.on('error', function (err) {
      if (err && err.type === 'unavailable-id') { state.idTaken = true; renderAll(); }
      /* peer-unavailable 等は日常的に起きるので握りつぶす */
    });
    peer.on('disconnected', function () { try { peer.reconnect(); } catch (e) {} });
  }
  function connectTo(code) {
    if (!state.peer || !state.peerOpen) return;
    var cur = state.conns[code];
    if (cur && (cur.open || cur.pending)) return;
    var c;
    try { c = state.peer.connect(PEER_PREFIX + code, { reliable: true }); }
    catch (e) { return; }
    wireConn(c, code, 'out');
  }
  function wireConn(c, code, direction) {
    /* 同時接続（グレア）対策: 両側が同時に接続し合っても、勝者は
       「接続を開始した側のコードが小さい方」で両側一致に決める */
    var initiator = direction === 'out' ? profile.code : code;
    var entry = { conn: c, open: false, pending: true, lastSeen: 0, initiator: initiator };
    var prev = state.conns[code];
    if (!prev || !prev.open) state.conns[code] = entry;
    /* 開かなかった接続は掃除して再試行可能にする */
    setTimeout(function () {
      if (state.conns[code] === entry && !entry.open) delete state.conns[code];
    }, 10000);
    c.on('open', function () {
      var cur = state.conns[code];
      if (cur && cur.conn !== c && cur.open) {
        /* 既存接続が無音（相手の再起動などで死んでいる）なら差し替える。
           生きていれば開始側コードの小さい方を勝者にする */
        var stale = cur.lastSeen && (Date.now() - cur.lastSeen > 25000);
        if (stale || initiator < cur.initiator) {
          try { cur.conn.close(); } catch (e) {}
        } else {
          try { c.close(); } catch (e) {}
          return;
        }
      }
      entry.open = true; entry.pending = false; entry.lastSeen = Date.now();
      state.conns[code] = entry;
      setPresence(code, { online: true });
      sendRaw(code, { t: 'hello', name: myName(), game: MY_GAME });
    });
    c.on('data', function (msg) {
      if (!state.conns[code] || state.conns[code].conn !== c) return;
      entry.lastSeen = Date.now();
      handleData(code, msg);
    });
    function drop() {
      if (state.conns[code] && state.conns[code].conn === c) {
        delete state.conns[code];
        setPresence(code, { online: false, game: null });
      }
    }
    c.on('close', drop);
    c.on('error', function () { /* close 側で処理 */ });
  }
  function setPresence(code, patch) {
    var p = state.presence[code] || (state.presence[code] = { online: false, name: '', game: null });
    var changed = false;
    for (var k in patch) { if (p[k] !== patch[k]) { p[k] = patch[k]; changed = true; } }
    if (changed) renderAll();
  }
  function sendRaw(code, obj) {
    var e = state.conns[code];
    if (e && e.open && e.conn) { try { e.conn.send(obj); return true; } catch (err) {} }
    return false;
  }
  function handleData(code, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'hello') {
      var nm = (typeof msg.name === 'string' && msg.name) ? msg.name.slice(0, 20) : '';
      setPresence(code, { online: true, name: nm, game: (typeof msg.game === 'string') ? msg.game : null });
      var f = friendOf(code);
      if (f && nm && f.name !== nm) { f.name = nm; saveFriends(); renderAll(); }
    }
    else if (msg.t === 'ping') { sendRaw(code, { t: 'pong' }); }
    else if (msg.t === 'pong') { /* lastSeen は受信時に更新済み */ }
    else if (msg.t === 'chat') {
      var text = (typeof msg.text === 'string') ? msg.text.slice(0, 500) : '';
      if (!text) return;
      pushChat(code, { f: 'th', x: text, ts: msg.ts || Date.now() });
      if (state.view === 'chat' && state.chatWith === code && (state.panelOpen || isInline())) {
        renderChatMsgs();
      } else {
        unread[code] = (unread[code] || 0) + 1; saveUnread();
      }
      updateBadge(); renderList();
    }
    else if (msg.t === 'invite') {
      var g = GAMES[msg.game] ? msg.game : null;
      var room = (typeof msg.room === 'string') ? msg.room.toUpperCase() : '';
      if (!g || !ROOM_RE.test(room)) return;
      state.invites.unshift({ from: code, name: displayName(code), game: g, room: room, ts: Date.now() });
      state.invites = state.invites.slice(0, 5);
      showInviteToast(state.invites[0]);
      renderAll();
    }
    else if (msg.t === 'bye') { setPresence(code, { online: false, game: null }); }
  }
  function pushChat(code, m) {
    var arr = chats[code] || (chats[code] = []);
    arr.push(m);
    if (arr.length > 200) chats[code] = arr.slice(-200);
    saveChats();
  }
  /* ハートビート＆再接続スイープ */
  setInterval(function () {
    var now = Date.now();
    Object.keys(state.conns).forEach(function (code) {
      var e = state.conns[code];
      if (e && e.open) {
        sendRaw(code, { t: 'ping' });
        if (e.lastSeen && now - e.lastSeen > 40000) {
          try { e.conn.close(); } catch (err) {}
          delete state.conns[code];
          setPresence(code, { online: false, game: null });
        }
      }
    });
  }, 15000);
  setInterval(function () {
    if (!state.peerOpen) return;
    friends.forEach(function (f) { if (!isOnline(f.code)) connectTo(f.code); });
  }, 12000);
  window.addEventListener('beforeunload', function () {
    Object.keys(state.conns).forEach(function (code) { sendRaw(code, { t: 'bye' }); });
    try { if (state.peer) state.peer.destroy(); } catch (e) {}
  });

  /* ---------------- 公開API（招待まわり） ---------------- */
  function detectRoomCode() {
    for (var i = 0; i < ROOM_CODE_SELS.length; i++) {
      var el = document.querySelector(ROOM_CODE_SELS[i]);
      if (el) {
        var t = (el.textContent || '').trim().toUpperCase();
        if (ROOM_RE.test(t)) return t;
      }
    }
    return null;
  }
  function sendInvite(code, game, room) {
    if (!GAMES[game] || !ROOM_RE.test(room || '')) return false;
    return sendRaw(code, { t: 'invite', game: game, room: room, from: myName() });
  }
  window.PWFriends = {
    version: 1,
    game: MY_GAME,
    profile: function () { return { name: profile.name, code: profile.code }; },
    isOnline: isOnline,
    sendInvite: sendInvite,
    detectRoomCode: detectRoomCode,
    openPanel: function () { openPanel(); },
    closePanel: function () { closePanel(); }
  };

  /* ---------------- UI ---------------- */
  var CSS = [
    '.pwf-root{font-family:"Hiragino Kaku Gothic ProN","Noto Sans JP",system-ui,sans-serif;color:#eef0ff;font-size:14px;line-height:1.5}',
    '.pwf-root *{box-sizing:border-box}',
    '.pwf-fab{position:fixed;right:14px;bottom:14px;z-index:100002;width:54px;height:54px;border-radius:50%;border:none;background:transparent;color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;touch-action:none;-webkit-tap-highlight-color:transparent;transition:transform .35s ease}',
    '.pwf-fab-face{position:absolute;inset:0;border-radius:50%;border:1px solid rgba(255,255,255,.3);background:linear-gradient(135deg,#0891b2,#7c3aed);box-shadow:0 10px 26px rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;font-size:24px;transition:opacity .35s ease;pointer-events:none}',
    '.pwf-fab.dim{transform:scale(.82)}',
    '.pwf-fab.dim .pwf-fab-face{opacity:.35}',
    '.pwf-fab.drag{transition:none;transform:scale(1.07)}',
    '.pwf-fab.drag .pwf-fab-face{opacity:1}',
    '.pwf-fab-badge{position:absolute;top:-5px;right:-5px;min-width:21px;height:21px;border-radius:999px;background:#ef4444;color:#fff;font-size:11.5px;font-weight:900;padding:0 5px;display:flex;align-items:center;justify-content:center;border:2px solid #0b1026}',
    '.pwf-overlay{position:fixed;inset:0;z-index:100001;background:rgba(3,4,12,.6);display:none;justify-content:flex-end}',
    '.pwf-overlay.show{display:flex}',
    '.pwf-panel{background:#0d1020;width:min(368px,94vw);height:100%;overflow-y:auto;padding:16px 16px 28px;box-shadow:-16px 0 44px rgba(0,0,0,.5)}',
    '.pwf-inline .pwf-panel{width:100%;height:auto;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.09);border-radius:18px;box-shadow:none;backdrop-filter:blur(6px)}',
    '.pwf-head{display:flex;align-items:center;justify-content:space-between;font-size:17px;font-weight:900;letter-spacing:.04em;margin-bottom:12px}',
    '.pwf-x{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);color:#eef0ff;width:32px;height:32px;border-radius:50%;font-size:14px;cursor:pointer}',
    '.pwf-sec{font-size:12px;font-weight:900;letter-spacing:.14em;color:#9aa1c0;margin:16px 0 8px}',
    '.pwf-row{display:flex;gap:8px;align-items:center}',
    '.pwf-input{flex:1;min-width:0;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.16);border-radius:10px;color:#fff;padding:9px 11px;font-size:14px;font-family:inherit;outline:none}',
    '.pwf-input:focus{border-color:#22d3ee}',
    '.pwf-btn{background:rgba(255,255,255,.09);border:1px solid rgba(255,255,255,.16);color:#eef0ff;border-radius:10px;padding:9px 13px;font-size:13px;font-weight:800;cursor:pointer;font-family:inherit;white-space:nowrap}',
    '.pwf-btn:active{transform:translateY(1px)}',
    '.pwf-btn.pri{background:linear-gradient(90deg,#0891b2,#7c3aed);border-color:transparent;color:#fff}',
    '.pwf-btn:disabled{opacity:.45;cursor:not-allowed}',
    '.pwf-note{font-size:11.5px;color:#9aa1c0;margin-top:6px;line-height:1.6}',
    '.pwf-note.err{color:#fca5a5}',
    '.pwf-mycode{font-size:19px;font-weight:900;letter-spacing:.18em;color:#fde68a}',
    '.pwf-friend{display:flex;align-items:center;gap:9px;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.08);border-radius:13px;padding:9px 11px;margin-bottom:8px}',
    '.pwf-dot{flex:0 0 auto;width:10px;height:10px;border-radius:50%;background:#5b6076}',
    '.pwf-dot.on{background:#4ade80;box-shadow:0 0 8px rgba(74,222,128,.8)}',
    '.pwf-fmeta{flex:1;min-width:0}',
    '.pwf-fname{font-weight:800;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.pwf-fstat{font-size:11.5px;color:#9aa1c0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.pwf-fstat.on{color:#86efac}',
    '.pwf-iconbtn{position:relative;flex:0 0 auto;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.13);color:#fff;border-radius:9px;padding:7px 9px;font-size:13px;cursor:pointer;font-family:inherit}',
    '.pwf-ubadge{position:absolute;top:-6px;right:-6px;min-width:18px;height:18px;border-radius:999px;background:#ef4444;color:#fff;font-size:10.5px;font-weight:900;padding:0 4px;display:flex;align-items:center;justify-content:center}',
    '.pwf-invite{background:linear-gradient(135deg,rgba(245,158,11,.18),rgba(239,68,68,.14));border:1px solid rgba(245,158,11,.45);border-radius:13px;padding:11px 12px;margin-bottom:9px}',
    '.pwf-invite b{color:#fde68a}',
    '.pwf-msgs{display:flex;flex-direction:column;gap:7px;max-height:46vh;overflow-y:auto;padding:4px 2px;margin:10px 0}',
    '.pwf-msg{max-width:82%;padding:8px 11px;border-radius:13px;font-size:13.5px;word-break:break-word;white-space:pre-wrap}',
    '.pwf-msg .pwf-ts{display:block;font-size:10px;opacity:.65;margin-top:3px}',
    '.pwf-msg.me{align-self:flex-end;background:linear-gradient(135deg,#0e7490,#6d28d9);color:#fff;border-bottom-right-radius:4px}',
    '.pwf-msg.th{align-self:flex-start;background:rgba(255,255,255,.09);border-bottom-left-radius:4px}',
    '.pwf-games{display:grid;grid-template-columns:1fr 1fr;gap:8px}',
    '.pwf-game{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:#eef0ff;border-radius:11px;padding:11px 8px;font-size:13px;font-weight:800;cursor:pointer;font-family:inherit}',
    '.pwf-toasts{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:100003;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none;width:min(94vw,430px)}',
    '.pwf-toast{pointer-events:auto;background:#14532d;color:#fff;font-size:13.5px;font-weight:700;padding:11px 16px;border-radius:13px;box-shadow:0 12px 30px rgba(0,0,0,.45);display:flex;gap:10px;align-items:center;max-width:100%}',
    '.pwf-toast.info{background:#1e293b}',
    '.pwf-toast .pwf-btn{padding:6px 12px}',
    '@media (max-width:480px){ .pwf-fab{bottom:12px;right:12px} }'
  ].join('\n');

  var els = {}; /* UI要素参照 */
  var inlineMode = false;
  function isInline() { return inlineMode; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtTs(ts) {
    var d = new Date(ts);
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }
  function toast(msg, kind, action) {
    var box = els.toasts;
    if (!box) return;
    var t = document.createElement('div');
    t.className = 'pwf-toast' + (kind === 'info' ? ' info' : '');
    var span = document.createElement('span');
    span.textContent = msg;
    t.appendChild(span);
    var killed = false;
    function kill() { if (!killed) { killed = true; if (t.parentNode) t.parentNode.removeChild(t); } }
    if (action) {
      var b = document.createElement('button');
      b.className = 'pwf-btn pri'; b.textContent = action.label;
      b.onclick = function () { kill(); action.fn(); };
      t.appendChild(b);
      var x = document.createElement('button');
      x.className = 'pwf-btn'; x.textContent = '✕';
      x.onclick = kill;
      t.appendChild(x);
      setTimeout(kill, 20000);
    } else {
      setTimeout(kill, 3400);
    }
    box.appendChild(t);
  }
  function showInviteToast(inv) {
    toast('🎮 ' + inv.name + 'さんから「' + GAMES[inv.game].title + '」への招待が届きました', '', {
      label: '参加する',
      fn: function () { location.href = GAMES[inv.game].file + '?join=' + inv.room; }
    });
  }

  function buildUI() {
    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    els.toasts = document.createElement('div');
    els.toasts.className = 'pwf-toasts';
    document.body.appendChild(els.toasts);

    var panelHtml =
      '<div class="pwf-head"><span>👥 フレンド</span>' +
      (inlineMode ? '' : '<button class="pwf-x" id="pwfClose" aria-label="閉じる">✕</button>') + '</div>' +
      '<div class="pwf-sec">あなた</div>' +
      '<div class="pwf-row"><input class="pwf-input" id="pwfName" maxlength="12" placeholder="名前（例：たろう）">' +
      '<button class="pwf-btn" id="pwfNameSave">保存</button></div>' +
      '<div class="pwf-note" id="pwfNameNote"></div>' +
      '<div class="pwf-row" style="margin-top:10px;flex-wrap:wrap"><span style="font-size:12px;color:#9aa1c0;white-space:nowrap">フレンドコード</span>' +
      '<span class="pwf-mycode" id="pwfMyCode"></span>' +
      '<button class="pwf-btn" id="pwfCopy">📋 コピー</button>' +
      '<button class="pwf-btn" id="pwfRegen">再生成</button></div>' +
      '<div class="pwf-note" id="pwfMeNote"></div>' +
      '<div class="pwf-sec">フレンドを追加</div>' +
      '<div class="pwf-row"><input class="pwf-input" id="pwfAddCode" maxlength="8" placeholder="相手のコード（8文字）" autocomplete="off">' +
      '<button class="pwf-btn pri" id="pwfAddBtn">追加</button></div>' +
      '<div class="pwf-note" id="pwfAddNote"></div>' +
      '<div id="pwfInvites"></div>' +
      '<div id="pwfListView">' +
        '<div class="pwf-sec">フレンド <span id="pwfCount"></span></div>' +
        '<div id="pwfList"></div>' +
        '<div class="pwf-note" id="pwfEmpty"></div>' +
      '</div>' +
      '<div id="pwfChatView" style="display:none">' +
        '<div class="pwf-row"><button class="pwf-btn" id="pwfChatBack">← もどる</button><b id="pwfChatHead"></b></div>' +
        '<div class="pwf-msgs" id="pwfChatMsgs"></div>' +
        '<div class="pwf-row"><input class="pwf-input" id="pwfChatInput" maxlength="500" placeholder="メッセージ">' +
        '<button class="pwf-btn pri" id="pwfChatSend">送信</button></div>' +
        '<div class="pwf-note" id="pwfChatNote"></div>' +
      '</div>' +
      '<div id="pwfPickView" style="display:none">' +
        '<div class="pwf-row"><button class="pwf-btn" id="pwfPickBack">← もどる</button><b id="pwfPickTitle"></b></div>' +
        '<div id="pwfPickRoom" style="margin-top:10px"></div>' +
        '<div class="pwf-sec">ゲームを選んで招待（選ぶと部屋を作りに移動します）</div>' +
        '<div class="pwf-games" id="pwfPickGrid"></div>' +
      '</div>' +
      '<div class="pwf-note" style="margin-top:16px">オンライン状態は相手がPlayWebを開いている時だけ分かります。メッセージと招待は、両方がオンラインの時だけ届きます。</div>';

    var portalBox = document.getElementById('pwFriendsPortal');
    if (portalBox) {
      inlineMode = true;
      portalBox.classList.add('pwf-root', 'pwf-inline');
      var inner = document.createElement('div');
      inner.className = 'pwf-panel';
      inner.innerHTML = panelHtml;
      portalBox.appendChild(inner);
      els.panel = inner;
    } else {
      els.fab = document.createElement('button');
      els.fab.className = 'pwf-fab';
      els.fab.innerHTML = '<span class="pwf-fab-face">👥</span><span class="pwf-fab-badge" id="pwfFabBadge" style="display:none"></span>';
      els.fab.setAttribute('aria-label', 'フレンド');
      document.body.appendChild(els.fab);
      els.fab.onclick = function () {
        if (fabSuppressClick) { fabSuppressClick = false; return; } /* ドラッグ直後の click は無視 */
        openPanel();
      };
      initFab();
      els.overlay = document.createElement('div');
      els.overlay.className = 'pwf-overlay pwf-root';
      var p = document.createElement('div');
      p.className = 'pwf-panel';
      p.innerHTML = panelHtml;
      els.overlay.appendChild(p);
      document.body.appendChild(els.overlay);
      els.panel = p;
      els.overlay.addEventListener('click', function (e) { if (e.target === els.overlay) closePanel(); });
    }
    bindPanelEvents();
    renderAll();
  }
  function $(id) { return document.getElementById(id); }
  function openPanel() {
    state.panelOpen = true;
    fabWake();
    if (els.overlay) els.overlay.classList.add('show');
    renderAll();
  }
  function closePanel() {
    state.panelOpen = false;
    if (els.overlay) els.overlay.classList.remove('show');
    fabWake();
  }

  /* ---------- フレンドボタン（FAB）: 控えめ表示とドラッグ移動 ---------- */
  var FAB_DIM_MS = 3500;    /* 操作がなければこの時間で控えめ表示にする */
  var FAB_DRAG_THRESH = 8;  /* px: これ未満の移動はタップ扱い */
  var fabIdleTimer = null;
  var fabSuppressClick = false;
  var fabLastBadge = 0;

  function fabMargin() { return window.innerWidth <= 480 ? 12 : 14; }
  function loadFabPos() {
    var p = lsGet(LS_FABPOS, null);
    if (p && (p.edge === 'left' || p.edge === 'right') &&
        typeof p.bottom === 'number' && isFinite(p.bottom)) return p;
    return null;
  }
  function applyFabPos() {
    if (!els.fab) return;
    var fab = els.fab, p = loadFabPos();
    if (!p) { /* 保存位置なし: CSS のデフォルト（右下）に戻す */
      fab.style.left = ''; fab.style.right = ''; fab.style.top = ''; fab.style.bottom = '';
      return;
    }
    var maxBottom = Math.max(8, window.innerHeight - fab.offsetHeight - 8);
    var bottom = Math.min(Math.max(8, p.bottom), maxBottom);
    fab.style.top = '';
    fab.style.bottom = bottom + 'px';
    if (p.edge === 'left') { fab.style.left = fabMargin() + 'px'; fab.style.right = 'auto'; }
    else { fab.style.right = fabMargin() + 'px'; fab.style.left = 'auto'; }
  }
  function saveFabPos(edge, bottom) {
    lsSet(LS_FABPOS, { edge: edge, bottom: Math.round(bottom) });
  }
  /* ボタンを通常表示に戻し、控えめ表示までのタイマーを仕切り直す */
  function fabWake() {
    if (!els.fab) return;
    els.fab.classList.remove('dim');
    if (fabIdleTimer) clearTimeout(fabIdleTimer);
    fabIdleTimer = setTimeout(function () {
      fabIdleTimer = null;
      if (!els.fab) return;
      if (state.panelOpen || els.fab.classList.contains('drag')) { fabWake(); return; }
      els.fab.classList.add('dim');
    }, FAB_DIM_MS);
  }
  function initFab() {
    var fab = els.fab;
    if (!fab) return;
    applyFabPos();
    fabWake();
    window.addEventListener('resize', applyFabPos);
    fab.addEventListener('pointerenter', fabWake);
    fab.addEventListener('pointerdown', function (e) {
      fabWake();
      var startX = e.clientX, startY = e.clientY;
      var rect = fab.getBoundingClientRect();
      var offX = startX - rect.left, offY = startY - rect.top;
      var dragging = false;
      try { fab.setPointerCapture(e.pointerId); } catch (err) {}
      function onMove(ev) {
        if (!dragging) {
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < FAB_DRAG_THRESH) return;
          dragging = true;
          fab.classList.add('drag');
          fab.style.right = 'auto'; fab.style.bottom = 'auto'; /* 自由配置（left/top）へ */
        }
        if (ev.cancelable) ev.preventDefault(); /* ドラッグ中の画面スクロールを止める */
        var w = fab.offsetWidth, h = fab.offsetHeight;
        var nx = Math.min(Math.max(0, ev.clientX - offX), Math.max(0, window.innerWidth - w));
        var ny = Math.min(Math.max(0, ev.clientY - offY), Math.max(0, window.innerHeight - h));
        fab.style.left = nx + 'px';
        fab.style.top = ny + 'px';
      }
      function onUp() {
        fab.removeEventListener('pointermove', onMove);
        fab.removeEventListener('pointerup', onUp);
        fab.removeEventListener('pointercancel', onUp);
        if (!dragging) return; /* タップ: 通常の click（パネルを開く）に任せる */
        dragging = false;
        fab.classList.remove('drag');
        fabSuppressClick = true;
        setTimeout(function () { fabSuppressClick = false; }, 350);
        /* 最寄りの画面端へ寄せて保存し、全ページで共有する */
        var r = fab.getBoundingClientRect();
        var edge = (r.left + r.width / 2) < window.innerWidth / 2 ? 'left' : 'right';
        saveFabPos(edge, window.innerHeight - r.bottom);
        fab.style.left = ''; fab.style.top = '';
        applyFabPos();
        fabWake();
      }
      fab.addEventListener('pointermove', onMove);
      fab.addEventListener('pointerup', onUp);
      fab.addEventListener('pointercancel', onUp);
    });
  }

  function bindPanelEvents() {
    if (!inlineMode) $('pwfClose').onclick = closePanel;
    $('pwfNameSave').onclick = function () {
      profile.name = $('pwfName').value.trim().slice(0, 12);
      saveProfile();
      /* 名前変更を接続中のフレンドへ知らせる */
      Object.keys(state.conns).forEach(function (code) {
        sendRaw(code, { t: 'hello', name: myName(), game: MY_GAME });
      });
      $('pwfNameNote').textContent = '名前を保存しました';
      renderList();
    };
    $('pwfCopy').onclick = function () {
      var done = function () { toast('フレンドコードをコピーしました', 'info'); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(profile.code).then(done, function () { fallbackCopy(profile.code); done(); });
      } else { fallbackCopy(profile.code); done(); }
    };
    $('pwfRegen').onclick = function () {
      if (!window.confirm('フレンドコードを再生成しますか？\n今のコードは使えなくなり、フレンドには新しいコードを伝え直す必要があります。')) return;
      try { if (state.peer) state.peer.destroy(); } catch (e) {}
      state.peer = null; state.peerOpen = false; state.conns = {}; state.presence = {};
      profile.code = genCode(8);
      saveProfile();
      startPeer();
      renderAll();
      toast('新しいフレンドコードを発行しました', 'info');
    };
    $('pwfAddBtn').onclick = addFriendFromUI;
    $('pwfAddCode').addEventListener('keydown', function (e) { if (e.key === 'Enter') addFriendFromUI(); });
    $('pwfChatBack').onclick = function () { state.view = 'list'; state.chatWith = null; renderAll(); };
    $('pwfPickBack').onclick = function () { state.view = 'list'; state.pickFor = null; renderAll(); };
    $('pwfChatSend').onclick = sendChatFromUI;
    $('pwfChatInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') sendChatFromUI(); });
  }
  function fallbackCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
    } catch (e) {}
  }
  function addFriendFromUI() {
    var note = $('pwfAddNote');
    var code = cleanCode($('pwfAddCode').value);
    note.classList.remove('err');
    if (code.length !== 8) { note.textContent = 'コードは8文字で入力してください'; note.classList.add('err'); return; }
    if (code === profile.code) { note.textContent = 'それはあなた自身のコードです'; note.classList.add('err'); return; }
    if (friendOf(code)) { note.textContent = 'すでにフレンドに登録されています'; note.classList.add('err'); return; }
    friends.push({ code: code, name: '', addedAt: Date.now() });
    saveFriends();
    $('pwfAddCode').value = '';
    note.textContent = 'フレンドを追加しました。相手がオンラインになると状態が表示されます。';
    connectTo(code);
    renderAll();
  }
  function sendChatFromUI() {
    var code = state.chatWith;
    if (!code) return;
    var input = $('pwfChatInput');
    var text = input.value.trim();
    if (!text) return;
    if (!isOnline(code)) { $('pwfChatNote').textContent = '相手がオフラインのため送信できません'; return; }
    if (sendRaw(code, { t: 'chat', text: text, ts: Date.now() })) {
      pushChat(code, { f: 'me', x: text, ts: Date.now() });
      input.value = '';
      $('pwfChatNote').textContent = '';
      renderChatMsgs();
    } else {
      $('pwfChatNote').textContent = '送信できませんでした（接続が切れています）';
    }
  }

  /* ---------- 描画 ---------- */
  function renderAll() {
    if (!els.panel) return;
    renderProfile();
    renderInvites();
    renderList();
    if (state.view === 'chat') renderChat();
    if (state.view === 'pick') renderPicker();
    updateBadge();
  }
  function renderProfile() {
    var codeEl = $('pwfMyCode');
    if (codeEl) codeEl.textContent = profile.code;
    var nameEl = $('pwfName');
    if (nameEl && document.activeElement !== nameEl) nameEl.value = profile.name || '';
    var note = $('pwfMeNote');
    if (note) {
      if (state.unavailable) note.textContent = 'オンライン機能を読み込めませんでした（通信環境を確認してください）。フレンド機能は使えませんが、ゲームは遊べます。';
      else if (state.idTaken) note.textContent = 'このコードは別のタブ・端末で使用中です。そちらを閉じると、ここがオンラインになります。';
      else if (!state.peerOpen) note.textContent = '接続中…';
      else note.textContent = 'オンラインです。フレンドにはあなたの状態が見えます。';
    }
  }
  function totalUnread() {
    var n = 0;
    Object.keys(unread).forEach(function (k) { n += unread[k] || 0; });
    return n;
  }
  function updateBadge() {
    var b = $('pwfFabBadge');
    if (!b) return;
    var n = totalUnread() + state.invites.length;
    b.style.display = n > 0 ? 'flex' : 'none';
    b.textContent = n > 99 ? '99+' : String(n);
    /* 新着（未読・招待）が増えたらボタンを通常表示に戻して気づかせる。
       控えめ表示中でもバッジ自体は薄くならないので見落としにくい。 */
    if (n > fabLastBadge) fabWake();
    fabLastBadge = n;
  }
  function renderInvites() {
    var box = $('pwfInvites');
    if (!box) return;
    if (!state.invites.length) { box.innerHTML = ''; return; }
    box.innerHTML = '<div class="pwf-sec">届いている招待</div>' + state.invites.map(function (inv, i) {
      return '<div class="pwf-invite"><b>' + esc(inv.name) + '</b> さんから「' + esc(GAMES[inv.game].title) +
        '」への招待<br><span style="font-size:12px;color:#9aa1c0">ルームコード: ' + esc(inv.room) + '</span>' +
        '<div class="pwf-row" style="margin-top:8px"><button class="pwf-btn pri" data-inv-join="' + i + '">参加する</button>' +
        '<button class="pwf-btn" data-inv-del="' + i + '">閉じる</button></div></div>';
    }).join('');
    box.querySelectorAll('[data-inv-join]').forEach(function (btn) {
      btn.onclick = function () {
        var inv = state.invites[Number(btn.getAttribute('data-inv-join'))];
        if (inv) location.href = GAMES[inv.game].file + '?join=' + inv.room;
      };
    });
    box.querySelectorAll('[data-inv-del]').forEach(function (btn) {
      btn.onclick = function () {
        state.invites.splice(Number(btn.getAttribute('data-inv-del')), 1);
        renderAll();
      };
    });
  }
  function renderList() {
    var listEl = $('pwfList');
    if (!listEl) return;
    var lv = $('pwfListView'), cv = $('pwfChatView'), pv = $('pwfPickView');
    if (lv) lv.style.display = state.view === 'list' ? '' : 'none';
    if (cv) cv.style.display = state.view === 'chat' ? '' : 'none';
    if (pv) pv.style.display = state.view === 'pick' ? '' : 'none';
    var cnt = $('pwfCount');
    if (cnt) cnt.textContent = '（' + friends.length + '人）';
    var empty = $('pwfEmpty');
    if (empty) empty.textContent = friends.length ? '' : 'まだフレンドがいません。コードを交換して追加しましょう。相手がPlayWebを開くと、ここにオンライン状態が表示されます。';
    listEl.innerHTML = friends.map(function (f) {
      var on = isOnline(f.code);
      var un = unread[f.code] || 0;
      return '<div class="pwf-friend"><span class="pwf-dot' + (on ? ' on' : '') + '"></span>' +
        '<div class="pwf-fmeta"><div class="pwf-fname">' + esc(displayName(f.code)) + '</div>' +
        '<div class="pwf-fstat' + (on ? ' on' : '') + '">' + esc(presenceText(f.code)) + '</div></div>' +
        '<button class="pwf-iconbtn" data-act="chat" data-code="' + f.code + '">💬' + (un ? '<span class="pwf-ubadge">' + un + '</span>' : '') + '</button>' +
        '<button class="pwf-iconbtn" data-act="pick" data-code="' + f.code + '"' + (on ? '' : ' disabled style="opacity:.4"') + '>🎮</button>' +
        '<button class="pwf-iconbtn" data-act="del" data-code="' + f.code + '">✕</button></div>';
    }).join('');
    listEl.querySelectorAll('[data-act]').forEach(function (btn) {
      btn.onclick = function () {
        var code = btn.getAttribute('data-code'), act = btn.getAttribute('data-act');
        if (act === 'chat') {
          state.view = 'chat'; state.chatWith = code;
          unread[code] = 0; saveUnread();
          renderAll();
        } else if (act === 'pick') {
          state.view = 'pick'; state.pickFor = code;
          renderAll();
        } else if (act === 'del') {
          if (!window.confirm(displayName(code) + 'さんをフレンドから削除しますか？')) return;
          friends = friends.filter(function (x) { return x.code !== code; });
          delete chats[code]; delete unread[code];
          var e = state.conns[code];
          if (e && e.conn) { try { e.conn.close(); } catch (err) {} }
          delete state.conns[code]; delete state.presence[code];
          saveFriends(); saveChats(); saveUnread();
          renderAll();
        }
      };
    });
  }
  function renderChat() {
    var code = state.chatWith;
    if (!code) return;
    $('pwfChatHead').textContent = displayName(code);
    var note = $('pwfChatNote');
    if (note) note.textContent = isOnline(code) ? presenceText(code) : 'オフラインです。メッセージは送信できません。';
    var send = $('pwfChatSend');
    if (send) send.disabled = !isOnline(code);
    renderChatMsgs();
  }
  function renderChatMsgs() {
    var box = $('pwfChatMsgs');
    if (!box || state.view !== 'chat') return;
    var arr = chats[state.chatWith] || [];
    box.innerHTML = arr.map(function (m) {
      return '<div class="pwf-msg ' + (m.f === 'me' ? 'me' : 'th') + '">' + esc(m.x) +
        '<span class="pwf-ts">' + fmtTs(m.ts) + '</span></div>';
    }).join('') || '<div class="pwf-note">まだメッセージがありません</div>';
    box.scrollTop = box.scrollHeight;
  }
  function renderPicker() {
    var code = state.pickFor;
    if (!code) return;
    $('pwfPickTitle').textContent = displayName(code) + 'さんを招待';
    var roomBox = $('pwfPickRoom');
    var room = (MY_GAME !== 'portal') ? detectRoomCode() : null;
    if (roomBox) {
      roomBox.innerHTML = room
        ? '<button class="pwf-btn pri" id="pwfPickRoomBtn" style="width:100%">🏠 いま開いている部屋（' + esc(room) + '）に招待する</button>'
        : '';
      var rb = $('pwfPickRoomBtn');
      if (rb) rb.onclick = function () {
        if (sendInvite(code, MY_GAME, room)) {
          toast(displayName(code) + 'さんに招待を送りました', 'info');
          state.view = 'list'; state.pickFor = null; renderAll();
        } else {
          toast('招待を送れませんでした（接続が切れています）', 'info');
        }
      };
    }
    var grid = $('pwfPickGrid');
    if (grid) {
      grid.innerHTML = GAME_ORDER.map(function (g) {
        return '<button class="pwf-game" data-game="' + g + '">' + esc(GAMES[g].title) + '</button>';
      }).join('');
      grid.querySelectorAll('[data-game]').forEach(function (btn) {
        btn.onclick = function () {
          var g = btn.getAttribute('data-game');
          location.href = GAMES[g].file + '?hostinvite=' + encodeURIComponent(code);
        };
      });
    }
  }

  /* ---------------- ?join / ?hostinvite フック ----------------
     各ゲームは window.PW_JOIN_CFG = {
       openers: [{click:'#vsBtn'} | {call:'showScreen', args:['sc-online']}],
       input: '#joinCode', joinBtn: '#joinBtn' | joinCall: 'joinRoom',
       hostBtn: '#hostBtn'
     } を設定する。friends.js がここで実際の操作を行う。 */
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function pollEl(sel, timeout) {
    return new Promise(function (resolve) {
      var t0 = Date.now();
      (function tick() {
        var el = null;
        try { el = document.querySelector(sel); } catch (e) {}
        if (el) return resolve(el);
        if (Date.now() - t0 > timeout) return resolve(null);
        setTimeout(tick, 200);
      })();
    });
  }
  function fillInput(el, val) {
    el.value = val;
    try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
    try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
  }
  function runOpeners(cfg) {
    var chain = Promise.resolve();
    (cfg.openers || []).forEach(function (op) {
      chain = chain.then(function () {
        if (op.click) {
          return pollEl(op.click, 6000).then(function (el) {
            if (el) { try { el.click(); } catch (e) {} }
            return sleep(450);
          });
        }
        if (op.call && typeof window[op.call] === 'function') {
          try { window[op.call].apply(null, op.args || []); } catch (e) {}
          return sleep(450);
        }
        return null;
      });
    });
    return chain;
  }
  function runJoinHook(code) {
    var cfg = window.PW_JOIN_CFG;
    if (!cfg || !cfg.input) return;
    window.PW_JOIN_STARTED = true;
    runOpeners(cfg).then(function () {
      return pollEl(cfg.input, 9000);
    }).then(function (input) {
      if (!input) return;
      fillInput(input, code);
      return sleep(250);
    }).then(function () {
      if (cfg.joinBtn) {
        return pollEl(cfg.joinBtn, 5000).then(function (btn) {
          if (btn) { try { btn.click(); } catch (e) {} window.PW_JOIN_TRIGGERED = true; }
        });
      }
      if (cfg.joinCall && typeof window[cfg.joinCall] === 'function') {
        try { window[cfg.joinCall](); } catch (e) {}
        window.PW_JOIN_TRIGGERED = true;
      }
    });
  }
  function runHostInviteHook(friendCode) {
    var cfg = window.PW_JOIN_CFG;
    if (!cfg || !cfg.hostBtn) return;
    window.PW_HOSTINVITE_STARTED = true;
    runOpeners(cfg).then(function () {
      return pollEl(cfg.hostBtn, 9000);
    }).then(function (btn) {
      if (btn) { try { btn.click(); } catch (e) {} }
      /* 部屋コードが表示され、相手がオンラインになるまで待って招待を送る */
      var t0 = Date.now();
      (function tick() {
        var room = detectRoomCode();
        if (room && sendInvite(friendCode, MY_GAME, room)) {
          toast('🎮 部屋を作成し、フレンドに招待を送りました', 'info');
          try {
            var u = new URL(location.href);
            u.searchParams.delete('hostinvite');
            history.replaceState(null, '', u.toString());
          } catch (e) {}
          window.PW_HOSTINVITE_SENT = room;
          return;
        }
        if (Date.now() - t0 > 45000) {
          toast('招待を送れませんでした（相手がオフラインか、部屋を作成できませんでした）', 'info');
          return;
        }
        setTimeout(tick, 700);
      })();
    });
  }
  function initHooks() {
    var params;
    try { params = new URLSearchParams(location.search); } catch (e) { return; }
    var join = params.get('join');
    if (join) {
      var code = join.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, '').slice(0, 6);
      if (code.length === 6) { runJoinHook(code); return; }
    }
    var hi = params.get('hostinvite');
    if (hi) {
      var fc = cleanCode(decodeURIComponent(hi));
      if (fc.length === 8 && friendOf(fc)) runHostInviteHook(fc);
    }
  }

  /* ---------------- 初期化 ---------------- */
  var peerLoadTried = false;
  function startPeerWhenReady() {
    if (typeof window.Peer !== 'undefined') { startPeer(); return; }
    if (peerLoadTried) { state.unavailable = true; renderAll(); return; }
    peerLoadTried = true;
    /* PeerJS が無いページ（ポータル等）では動的に読み込む */
    var s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js';
    s.onload = function () { startPeer(); };
    s.onerror = function () { state.unavailable = true; renderAll(); };
    document.head.appendChild(s);
  }
  function init() {
    buildUI();
    startPeerWhenReady();
    initHooks();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
