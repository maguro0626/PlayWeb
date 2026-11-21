/* ============================================================
   PlayWeb フレンド機能（friends.js）
   ------------------------------------------------------------
   アカウント（account.js）と連携する共通モジュール。v51〜 フレンドの
   同一性はフレンドコードではなくアカウントの uid に統一した。
   - 表示名は廃止（ユーザー名に統一）。localStorage 'playweb_profile' の
       name はもう書き込まない（既存データは無害なので残してよい）。
   - フレンド: localStorage 'playweb_friends' [{uid, username, addedAt}]
       追加は申請制: ユーザー名検索 → フレンド申請 → 相手が承認して初めて
       フレンドになる（account.js の sendFriendRequest / respondFriendRequest。
       申請は invites コレクションの kind:'friend' ドキュメント）。
   - PeerID は 'playweb-u-<uid>'。Peer チャネルは在席の補助・招待の
     フォールバック・matchjoin/matchroster（戦績の相手引き継ぎ）に使う。
   メッセージ種別: hello / ping / pong / invite / bye / matchjoin / matchroster
   ※ 1対1チャット機能は v55 で削除した（プロフィールの一言コメントのみ残す）。
     旧データ 'playweb_chats' / 'playweb_unread' はもう読み書きしない。
   各ページは読み込み前に次を設定する:
     window.PW_GAME = 'survivors' など（ポータルは 'portal'）
     window.PW_JOIN_CFG = {openers, input, joinBtn|joinCall, hostBtn}（任意）
   テスト用に window.PW_FRIENDS_PEER_OPTS があれば Peer の接続先を差し替える。
   このファイルが読み込めない/PeerJS が無い環境でもゲーム単体は従来どおり動く。

   【UI（v51〜）】
   フレンドパネルは account.js のアカウントドロワー内（#pwFriendsMount）に
   マウントする。右下 FAB は廃止。未読・招待のバッジはヘッダーの
   アカウントタブ（#pwTabBadge）に出す。パネルを開く = ドロワーを開く。

   【招待制オンライン（v2）】
   オンライン対戦はフレンド招待制。ルームコードは内部的な接続IDとしてのみ使い、
   ユーザーには見せない。ゲームページでは PW_JOIN_CFG からコード入力欄・参加/作成
   ボタン・コード表示を自動で隠し、「フレンドを招待」「フレンド戦績」バーを差し込む。
   ホスト開始は window.PW_AUTO_HOST()（未定義なら PW_JOIN_CFG から自動生成）、
   参加は招待クリック→ ?join=<room>&from=<相手uid> の内部遷移のみ。
   「招待済み」表示は重複送信防止のための一時状態で、相手の参加（matchjoin）・
   試合終了（recordMatch）・切断で解除され、最大90秒で失効する。再戦はいつでも可能。
   【戦績】
   localStorage 'playweb_records' {uid: {_name: 名前スナップショット,
     ゲームID: {w,l,d,plays,clears,last}}}
   名前の解決順: フレンド一覧/在席の現在名（ユーザー名） → _name スナップショット → 'フレンド'。
   対戦相手の uid は招待フローから引き継ぎ（ホスト=招待した相手、ゲスト=招待者）、
   ゲストは参加後に matchjoin を送り、ホストは matchroster で参加者全員の uid を配る。
   各ゲームは終了時に PWFriends.recordMatch('win'|'lose'|'draw'|'coop', {cleared}) を呼ぶ。
   戦績はこの端末ローカルにのみ保存される（自分がそのフレンドと遊んだ記録だけ）。

   【アカウント連携（account.js）】
   ログイン時は account.js が Firestore 経由で在席・招待・フレンド一覧を
   供給する。在席表示はクラウド在席（PWFriends._cloud.setPresence）を優先し、
   招待の送信は相手のアカウントが実在する場合クラウド経路を使う
   （オフラインでも届く）。引けない場合は PeerJS 送信にフォールバックする。
   ターン制ゲームの対戦は v55 から Firestore マッチ（match.js）が担い、
   リアルタイム系の対戦接続（matchjoin 等）は PeerJS のまま。
   ============================================================ */
(function () {
  'use strict';
  if (window.__pwFriendsLoaded) return;
  window.__pwFriendsLoaded = true;

  /* ---------------- 定数 ---------------- */
  var PEER_PREFIX = 'playweb-u-';
  var LS_PROFILE = 'playweb_profile', LS_FRIENDS = 'playweb_friends';
  var GAMES = {
    portal:     { title: 'ポータル',               file: 'index.html' },
    tetris:     { title: 'テトリス',               file: 'tetris.html' },
    suica:      { title: 'スイカゲーム',           file: 'suica.html' },
    survivors:  { title: 'まじょねこサバイバーズ', file: 'survivors.html', coop: true },
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
    caring:     { title: '育成ゲーム',             file: 'caring.html', coop: true },
    rpg:        { title: 'モンスターライズ',       file: 'rpg.html' },
    taiko:      { title: 'リンクドラムサーガ',     file: 'taiko.html' },
    snake:      { title: 'スネークアリーナ',       file: 'snake.html' },
    starrhythm: { title: 'スターリズム',           file: 'starrhythm.html' }
  };
  var GAME_ORDER = ['tetris','suica','survivors','blockblast','minesweeper','reversi','shogi','majan','daihugou','hanahuda','uno','blockzushi','jump','caring','rpg','taiko','snake','starrhythm'];
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
  function loadProfile() {
    var p = lsGet(LS_PROFILE, null);
    if (!p || typeof p !== 'object') p = { name: '' };
    if (typeof p.name !== 'string') p.name = '';
    return p; /* 旧 code フィールドが残っていても読み捨てる */
  }
  var profile = loadProfile();
  var friends = lsGet(LS_FRIENDS, []);
  if (!Array.isArray(friends)) friends = [];
  friends = friends.filter(function (f) { return f && typeof f.uid === 'string'; });
  /* 自分のアカウント uid（account.js のログイン状態から取る。未ログイン時は null） */
  function myUid() {
    try {
      var u = window.PWAccount && window.PWAccount.user && window.PWAccount.user();
      return (u && typeof u.uid === 'string') ? u.uid : null;
    } catch (e) { return null; }
  }
  /* URL パラメータ等から来た uid の整形（英数字・_・- のみ、最大64文字） */
  function cleanUid(s) {
    return String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  }

  /* ---------------- 戦績（playweb_records） ---------------- */
  var LS_RECORDS = 'playweb_records';
  var records = lsGet(LS_RECORDS, {});
  if (!records || typeof records !== 'object') records = {};
  function saveRecords() { lsSet(LS_RECORDS, records); }
  /* result: 'win' | 'lose' | 'draw' | 'coop'（coop は opts.cleared でクリア数も加算）
     キーは相手の uid。バケットには名前スナップショット _name も持たせ、
     フレンドを削除した後でも名前が引けるようにする */
  function recordResult(gameId, friendUid, result, opts) {
    if (!GAMES[gameId] || gameId === 'portal') return false;
    if (!friendUid || friendUid === myUid()) return false;
    if (result !== 'win' && result !== 'lose' && result !== 'draw' && result !== 'coop') return false;
    opts = opts || {};
    var byGame = records[friendUid] || (records[friendUid] = {});
    var nm = friendDisplayName(friendUid);
    if (nm) byGame._name = nm;
    var r = byGame[gameId] || (byGame[gameId] = { w: 0, l: 0, d: 0, plays: 0, clears: 0, last: 0 });
    r.plays++;
    if (result === 'win') r.w++;
    else if (result === 'lose') r.l++;
    else if (result === 'draw') r.d++;
    else if (result === 'coop' && opts.cleared) r.clears++;
    r.last = Date.now();
    saveRecords();
    return true;
  }
  /* 戦績用の名前解決: 在席名（=ユーザー名）→ フレンドのユーザー名
     → スナップショット → '' の順 */
  function friendDisplayName(uid) {
    var cp = cloudPresence[uid];
    if (cp && cp.name) return cp.name;
    var p = state.presence[uid];
    if (p && p.name) return p.name;
    var f = null;
    for (var i = 0; i < friends.length; i++) if (friends[i].uid === uid) { f = friends[i]; break; }
    if (f && f.username) return f.username;
    var rec = records[uid];
    if (rec && typeof rec._name === 'string' && rec._name) return rec._name;
    return '';
  }
  function recordSummary(uid) {
    var rec = records[uid];
    if (!rec) return '';
    var parts = [];
    GAME_ORDER.forEach(function (g) {
      var r = rec[g];
      if (!r || !r.plays) return;
      if (GAMES[g].coop) {
        parts.push(GAMES[g].title + ' 協力' + r.plays + '回' + (r.clears ? '・クリア' + r.clears : ''));
      } else {
        var s = GAMES[g].title + ' ' + r.w + '勝' + r.l + '敗';
        if (r.d) s += r.d + '分';
        parts.push(s);
      }
    });
    return parts.join(' ／ ');
  }

  /* ---------------- 対戦コンテキスト（相手の uid 引き継ぎ） ----------------
     sessionStorage 'pw_match' {game, role:'host'|'guest', room, peers:[uid], joinSent}
     ホスト: 招待した相手の uid を peers に保持する。
     ゲスト: 招待者の uid を peers に持ち、参加後に matchjoin をホストへ送る。
     ホストは matchjoin を受けて参加者を加え、matchroster で全員の uid を配る。 */
  var SS_MATCH = 'pw_match';
  var match = null;
  try { match = JSON.parse(sessionStorage.getItem(SS_MATCH) || 'null'); } catch (e) { match = null; }
  if (!match || typeof match !== 'object' || !Array.isArray(match.peers)) match = null;
  function saveMatch() {
    try {
      if (match) sessionStorage.setItem(SS_MATCH, JSON.stringify(match));
      else sessionStorage.removeItem(SS_MATCH);
    } catch (e) {}
  }
  function setMatch(m) { match = m; saveMatch(); }
  function matchPeers() {
    if (!match) return [];
    var me = myUid();
    return match.peers.filter(function (c) { return c && c !== me; });
  }
  function startHostMatch(peerUid) {
    if (match && match.game === MY_GAME && match.role === 'host') {
      if (match.peers.indexOf(peerUid) < 0) { match.peers.push(peerUid); saveMatch(); }
    } else {
      setMatch({ game: MY_GAME, role: 'host', room: null, peers: [peerUid], joinSent: false });
    }
  }
  function addMatchPeer(uid) {
    if (!match || !uid || uid === myUid()) return;
    if (match.peers.indexOf(uid) < 0) { match.peers.push(uid); saveMatch(); }
  }
  /* 同じ試合の終了処理が二重に呼ばれても1回だけ記録するためのガード */
  var lastMatchRecord = { key: '', ts: 0 };
  function recordMatch(outcome, opts) {
    if (MY_GAME === 'portal') return false;
    var peers = matchPeers();
    if (!peers.length) {
      /* 対戦コンテキスト未確定のまま試合が終わった場合の最終回収：
         フレンド一覧が既に届いていれば ?join から立て直して記録する
         （ensureJoinMatch は冪等で、立っていれば何もしない） */
      if (ensureJoinMatch()) peers = matchPeers();
    }
    if (!peers.length) return false;
    var key = MY_GAME + '|' + peers.slice().sort().join(',') + '|' + outcome + '|' + (opts && opts.cleared ? 1 : 0);
    var now = Date.now();
    if (lastMatchRecord.key === key && now - lastMatchRecord.ts < 4000) return false;
    lastMatchRecord = { key: key, ts: now };
    var ok = false;
    peers.forEach(function (code) { if (recordResult(MY_GAME, code, outcome, opts)) ok = true; });
    if (ok) clearInvited(); /* 試合終了: 「招待済み」表示を全解除して再戦できるようにする */
    if (ok && state.view === 'list') renderList();
    return ok;
  }
  /* ゲスト: ホストへ「参加した」ことをフレンド経路で知らせる */
  function trySendMatchJoin() {
    if (!match || match.role !== 'guest' || match.joinSent) return;
    var host = match.peers[0];
    if (!host) return;
    if (sendRaw(host, { t: 'matchjoin', game: match.game, room: match.room || '' })) {
      match.joinSent = true; saveMatch();
    }
  }

  function saveProfile() { lsSet(LS_PROFILE, profile); }
  function saveFriends() { lsSet(LS_FRIENDS, friends); }
  /* 自分の名前はアカウントのユーザー名に統一する（表示名は廃止）。
     PeerJS の hello / 招待の from にもユーザー名を使う */
  function myName() {
    try {
      var u = window.PWAccount && window.PWAccount.user && window.PWAccount.user();
      if (u && u.username) return u.username;
    } catch (e) {}
    return 'プレイヤー';
  }
  function friendOf(uid) {
    for (var i = 0; i < friends.length; i++) if (friends[i].uid === uid) return friends[i];
    return null;
  }

  /* ---------------- 状態 ---------------- */
  var state = {
    peer: null, peerOpen: false, unavailable: false, idTaken: false,
    conns: {},        /* code -> {conn, open, lastSeen} */
    presence: {},     /* code -> {online, name, game} */
    invites: [],      /* {from, name, game, room, ts} */
    view: 'list',     /* list | pick */
    pickFor: null,
    panelOpen: false
  };
  /* ---------------- アカウント（クラウド）連携 ----------------
     ログイン時は account.js が Firestore の公開プロフィールから在席を流し込む。
     クラウド在席がある相手はそちらを優先し、無い相手は従来の PeerJS 在席を使う。 */
  var cloudPresence = {}; /* code -> {online, name, game} */
  /* 自分宛のフレンド申請（pending）。account.js が invites 購読から
     _cloud.setFriendRequests で流し込む: [{id, fromUid, fromName, createdAt}] */
  var friendReqList = [];
  function cloudActive() {
    return !!(window.PWAccount && window.PWAccount.cloudActive && window.PWAccount.cloudActive());
  }
  function isOnline(code) {
    var cp = cloudPresence[code];
    if (cp) return !!cp.online;
    var p = state.presence[code];
    return !!(p && p.online);
  }
  /* lastSeen の相対表示（v52〜。account.js の relLastSeenText と同じ文言。
     account.js が無い環境でも friends.js 単体で表示できるよう小さく複製） */
  function relSeenText(ts) {
    if (!ts) return '';
    var diff = Date.now() - ts;
    if (diff < 90000) return 'たった今までオンライン';
    if (diff < 3600000) return Math.max(1, Math.floor(diff / 60000)) + '分前までオンライン';
    if (diff < 86400000) return Math.floor(diff / 3600000) + '時間前までオンライン';
    if (diff < 2 * 86400000) return '昨日までオンライン';
    return Math.floor(diff / 86400000) + '日前までオンライン';
  }
  function presenceText(code) {
    var cp = cloudPresence[code];
    if (cp) {
      if (!cp.online) return relSeenText(cp.lastSeen) || 'オフライン';
      if (cp.game && GAMES[cp.game]) {
        return cp.game === 'portal' ? 'オンライン・ポータル' : 'オンライン・' + GAMES[cp.game].title + 'でプレイ中';
      }
      return 'オンライン';
    }
    var p = state.presence[code];
    if (!p || !p.online) return 'オフライン';
    if (p.game && GAMES[p.game]) {
      return p.game === 'portal' ? 'オンライン・ポータル' : 'オンライン・' + GAMES[p.game].title + 'でプレイ中';
    }
    return 'オンライン';
  }
  /* フレンドのアバター（v52〜）。account.js の profileIcon を使い、
     無ければ頭文字の丸アイコンにフォールバックする */
  function avatarHTML(uid, size) {
    var s = size || 38;
    var cp = cloudPresence[uid] || {};
    if (window.PWAccount && window.PWAccount.profileIcon) {
      try {
        return window.PWAccount.profileIcon(
          { iconId: cp.iconId || '', iconColor: cp.iconColor || '', name: displayName(uid) }, s);
      } catch (e) {}
    }
    return '<span class="pwf-ava-fallback" style="width:' + s + 'px;height:' + s + 'px">' +
      esc((displayName(uid) || '?').slice(0, 1)) + '</span>';
  }
  function displayName(uid) {
    var cp = cloudPresence[uid];
    if (cp && cp.name) return cp.name;
    var p = state.presence[uid];
    if (p && p.name) return p.name;
    var f = friendOf(uid);
    if (f && f.username) return f.username;
    return friendDisplayName(uid) || 'フレンド';
  }

  /* ---------------- Peer / プレゼンス ---------------- */
  function peerOpts() { return window.PW_FRIENDS_PEER_OPTS || PEER_OPTS; }
  function startPeer() {
    if (typeof window.Peer === 'undefined') { state.unavailable = true; renderAll(); return; }
    var uid = myUid();
    if (!uid) { /* アカウント uid が無いと Peer ID を作れない（通常はメンバー時のみ呼ばれる） */
      state.peerSkipped = true; renderAll(); return;
    }
    try { state.peer = new Peer(PEER_PREFIX + uid, peerOpts()); }
    catch (e) { state.unavailable = true; renderAll(); return; }
    var peer = state.peer;
    peer.on('open', function () {
      state.peerOpen = true; state.idTaken = false;
      friends.forEach(function (f) { connectTo(f.uid); });
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
       「接続を開始した側の uid が小さい方」で両側一致に決める */
    var initiator = direction === 'out' ? myUid() : code;
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
        var stale = cur.lastSeen && (Date.now() - cur.lastSeen > 150000); /* 間隔はクラウド側ハートビート（120秒）とタイマー抑制時の ping 遅延より長く取る */
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
      trySendMatchJoin();
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
    }
    else if (msg.t === 'ping') { sendRaw(code, { t: 'pong' }); }
    else if (msg.t === 'pong') { /* lastSeen は受信時に更新済み */ }
    else if (msg.t === 'invite') {
      var g = GAMES[msg.game] ? msg.game : null;
      var room = (typeof msg.room === 'string') ? msg.room.toUpperCase() : '';
      if (!g || !ROOM_RE.test(room)) return;
      state.invites.unshift({ from: code, name: displayName(code), game: g, room: room, ts: Date.now() });
      state.invites = state.invites.slice(0, 5);
      showInviteToast(state.invites[0]);
      renderAll();
    }
    else if (msg.t === 'matchjoin') {
      /* ゲストが試合に参加した通知: ホストは参加者を記録し、全員分の uid を配る */
      var mg = GAMES[msg.game] ? msg.game : null;
      if (!mg) return;
      if (!match || match.game !== mg || match.role !== 'host') {
        setMatch({ game: mg, role: 'host', room: (typeof msg.room === 'string' ? msg.room : null), peers: [], joinSent: false });
      }
      addMatchPeer(code);
      clearInvited(code); /* 相手が参加したので「招待済み」表示は解除（試合後すぐ再招待できる） */
      var all = [myUid()].concat(match.peers);
      match.peers.slice().forEach(function (p) {
        sendRaw(p, { t: 'matchroster', game: mg, room: match.room || '', peers: all });
      });
    }
    else if (msg.t === 'matchroster') {
      if (!match || match.game !== msg.game || !Array.isArray(msg.peers)) return;
      msg.peers.forEach(function (c) { addMatchPeer(c); });
    }
    else if (msg.t === 'bye') { clearInvited(code); setPresence(code, { online: false, game: null }); }
  }
  /* ハートビート＆再接続スイープ
     無音で切断扱いにする閾値は 5 分（クラウド在席の PRESENCE_STALE_MS と同値）。
     以前は 40 秒で、バックグラウンドタブのタイマー抑制（Chrome の intensive
     throttling 等）で ping/pong が遅れるだけでオフライン表示に落ち、在席表示が
     数分単位でフリッカーする原因になっていた。クラウド側ハートビートが
     120 秒間隔になったのに合わせ、90 秒から 5 分へ引き上げた。 */
  var PRESENCE_DROP_MS = 300000;
  setInterval(function () {
    var now = Date.now();
    Object.keys(state.conns).forEach(function (code) {
      var e = state.conns[code];
      if (e && e.open) {
        sendRaw(code, { t: 'ping' });
        if (e.lastSeen && now - e.lastSeen > PRESENCE_DROP_MS) {
          try { e.conn.close(); } catch (err) {}
          delete state.conns[code];
          setPresence(code, { online: false, game: null });
        }
      }
    });
  }, 15000);
  function reconnectSweep() {
    if (!state.peerOpen) return;
    friends.forEach(function (f) { if (!isOnline(f.uid)) connectTo(f.uid); });
  }
  setInterval(reconnectSweep, 12000);
  /* タブ復帰・ネットワーク復帰時は、間隔タイマーを待たず即座に在席を立て直す。
     隠れたこと自体ではオフライン扱いにしない（切断判定は上の無音閾値だけ）。 */
  function refreshPresenceNow() {
    if (state.peer && !state.peerOpen) { try { state.peer.reconnect(); } catch (e) {} }
    Object.keys(state.conns).forEach(function (code) {
      var e = state.conns[code];
      if (e && e.open) {
        sendRaw(code, { t: 'ping' });
        sendRaw(code, { t: 'hello', name: myName(), game: MY_GAME });
      }
    });
    reconnectSweep();
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') refreshPresenceNow();
  });
  window.addEventListener('online', refreshPresenceNow);
  window.addEventListener('focus', refreshPresenceNow);
  window.addEventListener('beforeunload', function () {
    Object.keys(state.conns).forEach(function (code) { sendRaw(code, { t: 'bye' }); });
    try { if (state.peer) state.peer.destroy(); } catch (e) {}
  });

  /* ---------------- 公開API（招待まわり） ---------------- */
  /* 文字列からルームコードらしい6文字を抽出する。要素の表示テキストに
     ラベルや空白・改行が混ざっていても拾えるようにし、検出漏れで招待が
     送れなくなるのを防ぐ（従来は全文がコードと完全一致しないと無効だった） */
  function extractRoomCode(s) {
    if (typeof s !== 'string') return null;
    var m = s.toUpperCase().match(/[A-HJ-NP-Z2-9]{6}/);
    return m ? m[0] : null;
  }
  function detectRoomCode() {
    for (var i = 0; i < ROOM_CODE_SELS.length; i++) {
      var el = document.querySelector(ROOM_CODE_SELS[i]);
      if (el) {
        var code = extractRoomCode(el.textContent || '') ||
          (typeof el.value === 'string' ? extractRoomCode(el.value) : null);
        if (code) return code;
      }
    }
    return null;
  }
  function sendInvite(code, game, room) {
    if (gateBlocked()) return false;
    if (!GAMES[game] || !ROOM_RE.test(room || '')) return false;
    /* ログイン時は Firestore 招待を優先（相手がオフラインでも次に開いた時に届く）。
       相手のアカウントが実在しない場合だけ従来の PeerJS 送信にフォールバックする。 */
    if (cloudActive() && window.PWAccount.sendInviteCloud) {
      window.PWAccount.sendInviteCloud({ toUid: code, game: game, room: room }).then(function (ok) {
        if (!ok && !sendRaw(code, { t: 'invite', game: game, room: room, from: myName() })) {
          toast('招待を送れませんでした（相手との接続が切れています）', 'info');
        }
      }).catch(function () {});
      return true; /* 送信処理はクラウド側で進むため楽観的に成功扱い */
    }
    return sendRaw(code, { t: 'invite', game: game, room: room, from: myName() });
  }
  /* ゲーム側が window.PW_ROOM_CODE にコードを公開している場合はそちらを優先 */
  function currentRoomCode() {
    if (typeof window.PW_ROOM_CODE === 'string') {
      var c = extractRoomCode(window.PW_ROOM_CODE);
      if (c && window.PW_ROOM_CODE.trim().toUpperCase() === c) return c;
    }
    return detectRoomCode();
  }
  window.PWFriends = {
    version: 2,
    game: MY_GAME,
    /* account.js からのゲート通知（pending/member/guest/sdk-down） */
    _applyGate: function (state) { applyGate(state); },
    gateState: function () { return gateState; },
    loginNotice: loginNotice,
    profile: function () { return { name: myName(), uid: myUid() }; },
    isOnline: isOnline,
    sendInvite: sendInvite,
    detectRoomCode: currentRoomCode,
    openPanel: function () { openPanel(); },
    closePanel: function () { closePanel(); },
    openInvitePicker: function () { openInvitePicker(); },
    closeInvitePicker: function () { closeInvitePicker(); },
    openRecords: function (gameId) { openRecords(gameId); },
    recordResult: recordResult,
    recordMatch: recordMatch,
    invitedActive: invitedActive,
    clearInvited: clearInvited,
    matchPeers: matchPeers,
    matchInfo: function () { return match ? { game: match.game, role: match.role, room: match.room, peers: matchPeers() } : null; },
    getRecords: function (uid) {
      var rec = records[uid] || {}; var out = {};
      Object.keys(rec).forEach(function (g) { if (g !== '_name') out[g] = rec[g]; });
      return out;
    },
    autoHost: function () { callAutoHost(); },
    /* ---- account.js（クラウド）からのブリッジ ----
       ログイン時のみ account.js が使う。未ログイン時は一切呼ばれない。 */
    _cloud: {
      setPresence: function (code, info) {
        if (!code || !info) return;
        /* v52〜 プロフィール拡張（アイコン/コメント/最終オンライン/戦績/使用キャラ）も保持する */
        cloudPresence[code] = {
          online: !!info.online, name: info.name || '', game: info.game || null,
          lastSeen: info.lastSeen || 0, iconId: info.iconId || '', iconColor: info.iconColor || '',
          comment: info.comment || '', stats: info.stats || null, mainChar: info.mainChar || ''
        };
        renderAll();
      },
      clearPresence: function () { cloudPresence = {}; renderAll(); },
      /* クラウドから届いた招待（PeerJS 招待と同じ見た目・導線に合流させる） */
      receiveInvite: function (inv) {
        if (!inv || !GAMES[inv.game] || !ROOM_RE.test(inv.room || '')) return;
        for (var i = 0; i < state.invites.length; i++) {
          var o = state.invites[i];
          if (o.from === inv.from && o.game === inv.game && o.room === inv.room) return; /* 重複 */
        }
        var entry = {
          from: inv.from, name: inv.name || displayName(inv.from), game: inv.game,
          room: inv.room, ts: Date.now(), cloudId: inv.cloudId || null
        };
        state.invites.unshift(entry);
        state.invites = state.invites.slice(0, 5);
        showInviteToast(entry);
        renderAll();
      },
      /* フレンド一覧をクラウド同期結果で置き換える */
      setFriends: function (list) {
        if (!Array.isArray(list)) return;
        friends = list.filter(function (f) { return f && typeof f.uid === 'string'; });
        saveFriends();
        /* 一覧が届いたので、ゲート時点で friendOf に失敗して見送られた
           ?join / ?hostinvite の対戦コンテキスト設定を再試行する */
        retryPendingMatch();
        renderAll();
      },
      addFriend: function (entry) {
        if (!entry || !entry.uid || friendOf(entry.uid)) return false;
        friends.push(entry);
        saveFriends();
        retryPendingMatch();
        renderAll();
        return true;
      },
      getFriends: function () { return friends.slice(); },
      toast: function (msg, kind) { toast(msg, kind || 'info'); },
      /* 自分宛のフレンド申請（pending）の一覧を account.js から受け取る。
         新しく届いた申請は、パネルが閉じている時だけトーストでも知らせる
         （開いている時は申請セクションが見えているので出さない。
         ゲーム招待トーストの抑制ルールと揃える） */
      setFriendRequests: function (list) {
        var prev = {};
        friendReqList.forEach(function (r) { prev[r.id] = true; });
        friendReqList = Array.isArray(list) ? list.slice() : [];
        friendReqList.forEach(function (r) {
          if (!prev[r.id] && !state.panelOpen) {
            toast('👥 ' + (r.fromName || 'フレンド') + 'さんからフレンド申請が届きました', 'info',
              { label: '見る', fn: function () { openPanel(); } });
          }
        });
        renderAll();
      }
    },
    /* account.js のドロワー開閉にパネル状態を同期させる */
    _viewState: function (open) {
      state.panelOpen = !!open;
      if (open) renderAll();
      else flushPendingInviteToast();
    }
  };

  /* ---------------- 招待ピッカー（ゲーム内フレンド選択UI） ---------------- */
  var pickerOpen = false;
  var pickerInvited = {}; /* code -> 招待した時刻(ms)。「招待済み」表示は相手が参加するか
                             試合が終われば解除され、最大でも INVITED_TTL で失効する（再戦はいつでも可能） */
  var INVITED_TTL = 90000;
  function invitedActive(code) {
    var ts = pickerInvited[code];
    return !!ts && (Date.now() - ts) < INVITED_TTL;
  }
  function markInvited(code) { pickerInvited[code] = Date.now(); }
  function clearInvited(code) {
    if (code) delete pickerInvited[code];
    else pickerInvited = {};
    /* 開いたままのピッカーも即時更新する（閉じ忘れても「招待済み」で固まらない） */
    if (pickerOpen && els.pickerList) renderPickerList();
  }
  function buildPickerDom() {
    if (els.pickerOverlay) return;
    var ov = document.createElement('div');
    ov.className = 'pwf-modal-overlay pwf-root';
    ov.innerHTML = '<div class="pwf-modal">' +
      '<div class="pwf-head"><span id="pwfPickerTitle">👥 フレンドを招待</span>' +
      '<button class="pwf-x" id="pwfPickerClose" aria-label="閉じる">✕</button></div>' +
      '<div id="pwfPickerList"></div>' +
      '<div class="pwf-note" id="pwfPickerNote" style="margin-top:10px">オンライン中のフレンドだけ招待できます。選ぶと部屋を自動で作って招待を送ります。複数人対戦のゲームでは、続けて別のフレンドも招待できます。</div>' +
      '</div>';
    document.body.appendChild(ov);
    els.pickerOverlay = ov;
    els.pickerTitle = ov.querySelector('#pwfPickerTitle');
    els.pickerList = ov.querySelector('#pwfPickerList');
    ov.querySelector('#pwfPickerClose').onclick = closeInvitePicker;
    ov.addEventListener('click', function (e) { if (e.target === ov) closeInvitePicker(); });
  }
  function openInvitePicker() {
    if (gateBlocked()) { loginNotice(); return; }
    if (MY_GAME === 'portal') { openPanel(); return; }
    /* 招待制でないゲームではピッカーを開かずフレンドパネルを開く */
    if (GAMES[MY_GAME] && GAMES[MY_GAME].noInvite) { openPanel(); return; }
    buildPickerDom();
    pickerOpen = true;
    els.pickerOverlay.classList.add('show');
    renderPickerList();
  }
  function closeInvitePicker() {
    pickerOpen = false;
    if (els.pickerOverlay) els.pickerOverlay.classList.remove('show');
  }
  /* 同一HTMLの再描画を避けるためのキャッシュ。在席更新のたびに renderAll が
     走っても、内容が変わらない一覧は DOM を作り直さない（タップ中のボタンが
     detach して招待/参加のタップを取りこぼすのを防ぐ）。パネルDOMを作り直す
     タイミング（buildUI / teardown）で必ずクリアすること。 */
  var htmlCache = {};
  function setHtmlCached(el, key, html) {
    if (!el) return false;
    if (htmlCache[key] === html) return false;
    htmlCache[key] = html;
    el.innerHTML = html;
    return true;
  }
  function renderPickerList() {
    if (!els.pickerList) return;
    var g = GAMES[MY_GAME];
    if (els.pickerTitle) els.pickerTitle.textContent = '👥 フレンドを招待' + (g ? ' — ' + g.title : '');
    var noteEl = document.getElementById('pwfPickerNote');
    if (noteEl) noteEl.textContent = cloudActive()
      ? 'ログイン中は、オフラインのフレンドにも招待を送れます（相手が次にPlayWebを開いた時に届きます。部屋は開いたままお待ちください）。選ぶと部屋を自動で作って招待を送ります。'
      : 'オンライン中のフレンドだけ招待できます。選ぶと部屋を自動で作って招待を送ります。複数人対戦のゲームでは、続けて別のフレンドも招待できます。';
    if (!friends.length) {
      if (setHtmlCached(els.pickerList, 'picker', '<div class="pwf-note">まだフレンドがいません。オンライン対戦にはフレンドが必要です。まずアカウントタブの「フレンドを追加」で、相手のユーザー名を検索して追加してください。</div>' +
        '<button class="pwf-btn pri" id="pwfPickerAdd" style="margin-top:10px">フレンドを追加する</button>')) {
        var b = document.getElementById('pwfPickerAdd');
        if (b) b.onclick = function () { closeInvitePicker(); openPanel(); };
      }
      return;
    }
    if (!setHtmlCached(els.pickerList, 'picker', friends.map(function (f) {
      var on = isOnline(f.uid);
      var canInvite = on || cloudActive(); /* ログイン中はオフラインでも招待を送れる */
      var invited = invitedActive(f.uid);
      return '<div class="pwf-friend"><span class="pwf-dot' + (on ? ' on' : '') + '"></span>' +
        '<div class="pwf-fmeta"><div class="pwf-fname">' + esc(displayName(f.uid)) + '</div>' +
        '<div class="pwf-fstat' + (on ? ' on' : '') + '">' + esc(presenceText(f.uid)) + '</div></div>' +
        (invited
          ? '<button class="pwf-btn" disabled>招待済み ✓</button>'
          : '<button class="pwf-btn pri" data-invite="' + f.uid + '"' + (canInvite ? '' : ' disabled') + '>' + (canInvite ? '招待する' : 'オフライン') + '</button>') +
        '</div>';
    }).join(''))) return; /* 内容が同じなら既存DOM・リスナーを維持 */
    els.pickerList.querySelectorAll('[data-invite]').forEach(function (btn) {
      btn.onclick = function () { inviteFriendFlow(btn.getAttribute('data-invite'), btn); };
    });
  }
  function inviteFriendFlow(code, btn) {
    if (MY_GAME === 'portal') return;
    startHostMatch(code);
    var room = currentRoomCode();
    if (room) { finishInvite(code, room, btn); return; }
    if (btn) { btn.disabled = true; btn.textContent = '部屋を作成中…'; }
    callAutoHost();
    var t0 = Date.now();
    (function tick() {
      var r = currentRoomCode();
      if (r) { finishInvite(code, r, btn); return; }
      if (Date.now() - t0 > 30000) {
        toast('部屋を作成できませんでした。通信環境を確認してもう一度お試しください', 'info');
        /* ボタンは「部屋を作成中…」に書き換え済みで、内容が変わらないと
           描画キャッシュ（setHtmlCached）が効いて元に戻らず、ボタンが
           無効のまま固まって二度と招待できなくなる。キャッシュを破棄して
           描き直し、再招待できる状態に戻す（閉じている時も次回開く際に効く） */
        htmlCache.picker = null;
        if (pickerOpen) renderPickerList();
        return;
      }
      setTimeout(tick, 600);
    })();
  }
  function finishInvite(code, room, btn) {
    if (match && match.role === 'host' && match.game === MY_GAME) { match.room = room; saveMatch(); }
    if (sendInvite(code, MY_GAME, room)) {
      markInvited(code);
      toast(displayName(code) + 'さんに招待を送りました', 'info');
    } else {
      toast('招待を送れませんでした（相手との接続が切れています）', 'info');
    }
    /* 送信失敗時は「招待済み」状態が変わらず描画キャッシュが効いてしまう
       ため、部屋作成中に無効化したボタンが「部屋を作成中…」のまま固まる。
       キャッシュを破棄して描き直し、ボタンを復活させる（成功時は従来どおり
       招待済み表示に切り替わる） */
    htmlCache.picker = null;
    if (pickerOpen) renderPickerList();
  }
  /* PW_AUTO_HOST が無いゲームでは PW_JOIN_CFG から自動でホスト開始する */
  function autoHostViaCfg() {
    if (gateBlocked()) { loginNotice(); return Promise.resolve(false); }
    var cfg = window.PW_JOIN_CFG;
    if (!cfg || !cfg.hostBtn) return Promise.resolve(false);
    return runOpeners(cfg).then(function () { return pollEl(cfg.hostBtn, 9000); }).then(function (btn) {
      if (btn) { try { btn.click(); } catch (e) {} return true; }
      return false;
    });
  }
  function callAutoHost() {
    if (gateBlocked()) { loginNotice(); return; }
    if (typeof window.PW_AUTO_HOST === 'function') { try { window.PW_AUTO_HOST(); return; } catch (e) {} }
    autoHostViaCfg();
  }

  /* ---------------- 戦績オーバーレイ（ゲーム内・詳細） ---------------- */
  var recordsOpen = false;
  var recordsGame = null;
  function fmtDate(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    return d.getFullYear() + '/' + ('0' + (d.getMonth() + 1)).slice(-2) + '/' + ('0' + d.getDate()).slice(-2);
  }
  function buildRecordsDom() {
    if (els.recordsOverlay) return;
    var ov = document.createElement('div');
    ov.className = 'pwf-modal-overlay pwf-root';
    ov.innerHTML = '<div class="pwf-modal">' +
      '<div class="pwf-head"><span>📊 フレンド戦績</span>' +
      '<button class="pwf-x" id="pwfRecordsClose" aria-label="閉じる">✕</button></div>' +
      '<div class="pwf-row"><span style="font-size:12px;color:#9aa1c0;white-space:nowrap">ゲーム</span>' +
      '<select class="pwf-input" id="pwfRecordsSel"></select></div>' +
      '<div id="pwfRecordsList" style="margin-top:12px"></div>' +
      '<div class="pwf-note" style="margin-top:10px">戦績はこの端末にだけ保存され、あなたがそのフレンドと遊んだ記録です。</div>' +
      '</div>';
    document.body.appendChild(ov);
    els.recordsOverlay = ov;
    els.recordsSel = ov.querySelector('#pwfRecordsSel');
    els.recordsList = ov.querySelector('#pwfRecordsList');
    ov.querySelector('#pwfRecordsClose').onclick = closeRecords;
    ov.addEventListener('click', function (e) { if (e.target === ov) closeRecords(); });
    els.recordsSel.onchange = function () { recordsGame = els.recordsSel.value; renderRecords(); };
  }
  function openRecords(gameId) {
    if (gateBlocked()) { loginNotice(); return; }
    buildRecordsDom();
    recordsGame = (gameId && GAMES[gameId]) ? gameId : MY_GAME;
    recordsOpen = true;
    els.recordsOverlay.classList.add('show');
    renderRecords();
  }
  function closeRecords() {
    recordsOpen = false;
    if (els.recordsOverlay) els.recordsOverlay.classList.remove('show');
  }
  function renderRecords() {
    if (!els.recordsList) return;
    var g = (recordsGame && GAMES[recordsGame]) ? recordsGame : MY_GAME;
    recordsGame = g;
    els.recordsSel.innerHTML = GAME_ORDER.map(function (id) {
      return '<option value="' + id + '"' + (id === g ? ' selected' : '') + '>' + esc(GAMES[id].title) + '</option>';
    }).join('');
    if (!friends.length) {
      els.recordsList.innerHTML = '<div class="pwf-note">まだフレンドがいません</div>';
      return;
    }
    var coop = !!GAMES[g].coop;
    els.recordsList.innerHTML = friends.map(function (f) {
      var r = records[f.uid] && records[f.uid][g];
      var name = esc(displayName(f.uid));
      if (!r || !r.plays) {
        return '<div class="pwf-friend"><div class="pwf-fmeta"><div class="pwf-fname">' + name + '</div>' +
          '<div class="pwf-fstat">まだ対戦記録がありません</div></div></div>';
      }
      var line;
      if (coop) {
        line = '🤝 協力 ' + r.plays + '回' + (r.clears ? ' ／ クリア ' + r.clears + '回' : '');
      } else {
        var decided = r.w + r.l;
        var rate = decided ? Math.round(r.w / decided * 100) : 0;
        line = r.w + '勝 ' + r.l + '敗' + (r.d ? ' ' + r.d + '分' : '') + ' ／ 勝率 ' + rate + '% ／ 全' + r.plays + '試合';
      }
      return '<div class="pwf-friend"><div class="pwf-fmeta"><div class="pwf-fname">' + name + '</div>' +
        '<div class="pwf-fstat on" style="white-space:normal">' + esc(line) + '</div>' +
        '<div class="pwf-fstat">最終プレイ: ' + fmtDate(r.last) + '</div></div></div>';
    }).join('');
  }

  /* ---------------- ゲーム内UI変換（コードUIを隠し、招待/戦績バーを差し込む） ---------------- */
  function hideEl(el) { if (el) el.classList.add('pwf-hidden'); }
  /* el 自身から body までの祖先に display:none があれば「隠しサブツリー内」とみなす */
  function barChainHidden(el) {
    var a = el;
    while (a && a !== document.body) {
      var cs = null;
      try { cs = window.getComputedStyle(a); } catch (e) {}
      if (cs && cs.display === 'none') return true;
      a = a.parentElement;
    }
    return false;
  }
  /* ゲストバーを置ける「常に見える場所」を探す。
     (1) オンライン入口（openers）の隣: 入口自身は pwf-hidden でも、親チェーンが
         見えていればその場所に出す。入口が横並びのボタン行（flex row）の中なら、
         行コンテナ（高さ140px以下のもの）ごと手前に出す。
     (2) それも無ければ共通ヘッダー（#pwHeader）の直後。 */
  function guestBarTarget(cfg) {
    var ops = (cfg && cfg.openers) || [];
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      if (!op || !op.click) continue;
      var el = null;
      try { el = document.querySelector(op.click); } catch (e) {}
      if (!el || !el.parentNode) continue;
      if (barChainHidden(el.parentElement)) continue;
      var target = el;
      var p = el.parentElement;
      while (p && p !== document.body) {
        var cs = null;
        try { cs = window.getComputedStyle(p); } catch (e) {}
        if (!cs || cs.display !== 'flex' || (cs.flexDirection !== 'row' && cs.flexDirection !== 'row-reverse')) break;
        var r = null;
        try { r = p.getBoundingClientRect(); } catch (e) {}
        if (!r || r.height > 140) break;
        target = p;
        p = p.parentElement;
      }
      return { node: target, after: false };
    }
    var hdr = document.getElementById('pwHeader');
    if (hdr && hdr.parentNode) return { node: hdr, after: true };
    return null;
  }
  function buildGameBar(mode) {
    var bar = document.createElement('div');
    bar.className = 'pwf-gamebar pwf-root';
    bar.setAttribute('data-pw-mode', mode);
    if (mode === 'blocked') {
      bar.innerHTML = '<div class="pwf-gb-note" style="flex:1 1 200px">🔒 オンライン対戦・フレンド機能にはログインが必要です（ゲストは1人用のみ・セーブされません）</div>' +
        '<button class="pwf-gb-records pwf-gb-login">ログイン</button>';
      bar.querySelector('.pwf-gb-login').onclick = function () { loginNotice(); };
    } else {
      var coop = !!(GAMES[MY_GAME] && GAMES[MY_GAME].coop);
      bar.innerHTML = '<button class="pwf-gb-invite">' + (coop ? '👥 フレンドを招待して協力プレイ' : '👥 フレンドを招待して対戦') + '</button>' +
        '<button class="pwf-gb-records">📊 フレンド戦績</button>' +
        '<div class="pwf-gb-note">オンラインはフレンド招待制です（コード入力はありません）</div>';
      bar.querySelector('.pwf-gb-invite').onclick = function () { openInvitePicker(); };
      bar.querySelector('.pwf-gb-records').onclick = function () { openRecords(MY_GAME); };
    }
    return bar;
  }
  /* ゲストバーが隠しサブツリー内に埋もれていたら、可視スポットへ移設する。
     既に見えている場合は何もしない。戻り値は「見える場所に置けたか」 */
  function placeGuestBar(cfg, bar) {
    if (!bar) return false;
    if (bar.parentNode && !barChainHidden(bar)) return true;
    var spot = guestBarTarget(cfg);
    if (!spot || !spot.node.parentNode) return false;
    if (spot.after) spot.node.parentNode.insertBefore(bar, spot.node.nextSibling);
    else spot.node.parentNode.insertBefore(bar, spot.node);
    return !barChainHidden(bar);
  }
  /* ゲート: ゲスト時はオンライン入口自体も隠す。ログイン状態に戻ったら戻す */
  function applyOpenerGate(cfg, blocked) {
    if (!cfg.openers) return;
    cfg.openers.forEach(function (op) {
      if (!op.click) return;
      try {
        document.querySelectorAll(op.click).forEach(function (el) {
          if (blocked) el.classList.add('pwf-hidden');
          else el.classList.remove('pwf-hidden');
        });
      } catch (e) {}
    });
  }
  function transformGameUI() {
    if (MY_GAME === 'portal') return true;
    /* 招待制でないゲーム（リンクサーガ等の非同期オンライン）は招待バーを出さない */
    if (GAMES[MY_GAME] && GAMES[MY_GAME].noInvite) return true;
    var cfg = window.PW_JOIN_CFG;
    if (!cfg) return true;
    var blocked = gateBlocked();
    var anchor = null;
    if (cfg.hostBtn) { try { anchor = document.querySelector(cfg.hostBtn); } catch (e) {} }
    if (!anchor && cfg.input) { try { anchor = document.querySelector(cfg.input); } catch (e) {} }
    if (!anchor) {
      /* オンラインUIの要素がまだ無い（モードを開くまで生成されないゲームなど）。
         メンバー時は従来どおりリトライで待つ。ただしゲート未確定（pending）期に
         ゲスト扱いで隠した入口と案内バーは、メンバー確定時にここで巻き戻す
         （アンカー出現後の通常フローでメンバー用バーが作り直される）。
         ゲスト時は入口を封鎖したうえで、案内バーだけは常に見える場所へ先に出す
         （v50仕様: 入口ごと封鎖し案内を表示） */
      if (!blocked) {
        applyOpenerGate(cfg, false);
        var staleBar = document.querySelector('.pwf-gamebar');
        if (staleBar && staleBar.getAttribute('data-pw-mode') === 'blocked') staleBar.remove();
        return false;
      }
      applyOpenerGate(cfg, true);
      if (cfg.joinBtn) hideEl(document.querySelector(cfg.joinBtn));
      if (cfg.joinCall) {
        try { document.querySelectorAll('[onclick*="' + cfg.joinCall + '"]').forEach(hideEl); } catch (e) {}
      }
      var gBar = document.querySelector('.pwf-gamebar');
      if (gBar && gBar.getAttribute('data-pw-mode') !== 'blocked') { gBar.remove(); gBar = null; }
      if (!gBar) gBar = buildGameBar('blocked');
      return placeGuestBar(cfg, gBar);
    }
    if (cfg.input) hideEl(document.querySelector(cfg.input));
    if (cfg.joinBtn) hideEl(document.querySelector(cfg.joinBtn));
    hideEl(anchor && cfg.hostBtn ? document.querySelector(cfg.hostBtn) : null);
    if (cfg.joinCall) {
      try { document.querySelectorAll('[onclick*="' + cfg.joinCall + '"]').forEach(hideEl); } catch (e) {}
    }
    ['#copyCodeBtn', '#btn-copy-code', '#lobby-copy'].forEach(function (sel) {
      try { document.querySelectorAll(sel).forEach(hideEl); } catch (e) {}
    });
    ROOM_CODE_SELS.forEach(function (sel) {
      var el = null;
      try { el = document.querySelector(sel); } catch (e) {}
      if (el) {
        hideEl(el);
        var p = el.parentElement;
        if (p && /code/i.test(p.id || '')) hideEl(p);
      }
    });
    applyOpenerGate(cfg, blocked);
    var mode = blocked ? 'blocked' : 'member';
    var oldBar = document.querySelector('.pwf-gamebar');
    if (oldBar && oldBar.getAttribute('data-pw-mode') !== mode) { oldBar.remove(); oldBar = null; }
    if (!oldBar) {
      var bar = buildGameBar(mode);
      var target = anchor;
      var parent = anchor.parentElement;
      if (parent && parent.tagName === 'DIV' && parent.children.length <= 3 && parent.parentElement) target = parent;
      if (target.parentNode) target.parentNode.insertBefore(bar, target);
      oldBar = bar;
    }
    /* ゲストバーが隠しペイン内に埋もれている場合は可視スポットへ移設する
       （メンバー用バーはペイン内が正規の位置なので移設しない） */
    if (blocked) placeGuestBar(cfg, oldBar);
    return true;
  }
  function initGameUI() {
    if (MY_GAME === 'portal') return;
    var tries = 0;
    (function attempt() {
      if (transformGameUI()) return;
      if (++tries <= 8) setTimeout(attempt, 1200);
    })();
  }

  /* ---------------- UI ---------------- */
  var CSS = [
    '.pwf-root{font-family:"Hiragino Kaku Gothic ProN","Noto Sans JP",system-ui,sans-serif;color:#eef0ff;font-size:14px;line-height:1.5}',
    '.pwf-root *{box-sizing:border-box}',
    '.pwf-overlay{position:fixed;inset:0;z-index:100001;background:rgba(3,4,12,.6);display:none;justify-content:flex-end}',
    '.pwf-overlay.show{display:flex}',
    '.pwf-panel{background:#0d1020;width:min(368px,94vw);height:100%;overflow-y:auto;padding:16px 16px 28px;box-shadow:-16px 0 44px rgba(0,0,0,.5)}',
    /* アカウントドロワー内マウント時: ドロワー自体が半透明パネルなので中身はフラットに */
    '.pwf-indrawer .pwf-panel{width:100%;height:auto;background:transparent;border:none;border-radius:0;box-shadow:none;padding:2px 0 6px;overflow:visible}',
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
    '.pwf-friend{display:flex;align-items:center;gap:9px;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.08);border-radius:13px;padding:9px 11px;margin-bottom:8px}',
    '.pwf-dot{flex:0 0 auto;width:10px;height:10px;border-radius:50%;background:#5b6076}',
    '.pwf-dot.on{background:#4ade80;box-shadow:0 0 8px rgba(74,222,128,.8)}',
    '.pwf-fmeta{flex:1;min-width:0}',
    /* v52〜 アバター＋一言コメント */
    '.pwf-avawrap{position:relative;flex:0 0 auto;display:inline-flex}',
    '.pwf-avawrap .pwf-dot{position:absolute;right:-1px;bottom:-1px;width:11px;height:11px;border:2px solid #12162c;box-sizing:content-box}',
    '.pwf-ava-fallback{display:inline-flex;align-items:center;justify-content:center;border-radius:50%;background:#3b4a7a;color:#fff;font-weight:900;font-size:16px}',
    '.pwf-fcomment{font-size:11.5px;color:#a5b4fc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px}',
    '.pwf-fmeta[data-act="prof"]{cursor:pointer}',
    '.pwf-fname{font-weight:800;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.pwf-fstat{font-size:11.5px;color:#9aa1c0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.pwf-fstat.on{color:#86efac}',
    '.pwf-iconbtn{position:relative;flex:0 0 auto;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.13);color:#fff;border-radius:9px;padding:7px 9px;font-size:13px;cursor:pointer;font-family:inherit}',
    '.pwf-invite{background:linear-gradient(135deg,rgba(245,158,11,.18),rgba(239,68,68,.14));border:1px solid rgba(245,158,11,.45);border-radius:13px;padding:11px 12px;margin-bottom:9px}',
    '.pwf-invite b{color:#fde68a}',
    '.pwf-games{display:grid;grid-template-columns:1fr 1fr;gap:8px}',
    '.pwf-game{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:#eef0ff;border-radius:11px;padding:11px 8px;font-size:13px;font-weight:800;cursor:pointer;font-family:inherit}',
    '.pwf-toasts{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:100006;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none;width:min(94vw,430px)}',
    '.pwf-toast{pointer-events:auto;background:#14532d;color:#fff;font-size:13.5px;font-weight:700;padding:11px 16px;border-radius:13px;box-shadow:0 12px 30px rgba(0,0,0,.45);display:flex;gap:10px;align-items:center;max-width:100%}',
    '.pwf-toast.info{background:#1e293b}',
    '.pwf-toast .pwf-btn{padding:6px 12px}',
    '.pwf-hidden{display:none!important}',
    '.pwf-frec{font-size:11px;color:#a5b4fc;margin-top:2px;line-height:1.55}',
    '.pwf-gamebar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:10px 0;padding:11px;background:rgba(124,58,237,.16);border:1px solid rgba(167,139,250,.45);border-radius:13px;font-family:"Hiragino Kaku Gothic ProN","Noto Sans JP",system-ui,sans-serif}',
    '.pwf-gb-invite{flex:1 1 180px;background:linear-gradient(90deg,#0891b2,#7c3aed);border:none;color:#fff;border-radius:10px;padding:11px 13px;font-size:14px;font-weight:900;cursor:pointer;font-family:inherit}',
    '.pwf-gb-invite:active{transform:translateY(1px)}',
    '.pwf-gb-records{background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.25);color:#eef0ff;border-radius:10px;padding:11px 13px;font-size:13px;font-weight:800;cursor:pointer;font-family:inherit}',
    /* ゲストバーの「ログイン」は淡色背景のゲームでも読めるよう濃色の塗りにする */
    '.pwf-gb-login{background:linear-gradient(90deg,#0891b2,#7c3aed);border-color:transparent;color:#fff}',
    /* ゲストバーは置かれる場所の背景色に左右されないよう、土台を濃色で固定する */
    '.pwf-gamebar[data-pw-mode="blocked"]{background:rgba(49,10,101,.92)}',
    '.pwf-gb-note{flex-basis:100%;font-size:11.5px;color:#c3c8e8}',
    '.pwf-modal-overlay{position:fixed;inset:0;z-index:100005;background:rgba(3,4,12,.62);display:none;align-items:center;justify-content:center;padding:14px}',
    '.pwf-modal-overlay.show{display:flex}',
    '.pwf-modal{background:#0d1020;width:min(400px,94vw);max-width:100%;max-height:86vh;overflow-y:auto;border-radius:16px;padding:16px;box-shadow:0 20px 50px rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.12);color:#eef0ff}',
    /* 招待ピッカー等のモーダル内説明文が右端にはみ出さないためのガード:
       モーダル幅はオーバーレイの余白内（max-width:100%）に必ず収め、
       説明文（.pwf-note）は折り返し不能な並びでも強制的に折り返す。
       見出しは縮小可能にして ✕ ボタンが押し出されないようにする */
    '.pwf-modal .pwf-note{overflow-wrap:anywhere}',
    '.pwf-modal .pwf-head>span{min-width:0}',
    'select.pwf-input{appearance:auto}'
  ].join('\n');

  var els = {}; /* UI要素参照 */
  var inlineMode = false;
  /* ドロワー内マウント時は「パネルが見えている」= ドロワーが開いている時だけ。
     未読カウントの判定（チャット表示中は未読にしない）に使う */
  function isInline() { return inlineMode && state.panelOpen; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
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
  /* 招待を受けて参加する: 相手の uid を引き継いで遷移する */
  function gotoJoin(inv) {
    if (inv.cloudId && window.PWAccount && window.PWAccount.consumeInvite) {
      try { window.PWAccount.consumeInvite(inv.cloudId); } catch (e) {}
    }
    try {
      sessionStorage.setItem('pw_join_ctx', JSON.stringify({ game: inv.game, room: inv.room, from: inv.from, ts: Date.now() }));
    } catch (e) {}
    location.href = GAMES[inv.game].file + '?join=' + inv.room + '&from=' + inv.from;
  }
  /* ドロワーが開いている間に届いた招待トーストは保留し、閉じた時に出す。
     .pwf-toasts は画面下部中央に固定されるため、開いているドロワー下部の
     招待欄（「参加する」ボタン）と重なってタップを妨げ得るのが理由。
     ドロワー表示中は、招待欄とアカウントタブのバッジで招待に気づける。 */
  var pendingInviteToast = null;
  function showInviteToast(inv) {
    if (state.panelOpen) { pendingInviteToast = inv; return; }
    showInviteToastNow(inv);
  }
  function showInviteToastNow(inv) {
    toast('🎮 ' + inv.name + 'さんから「' + GAMES[inv.game].title + '」への招待が届きました', '', {
      label: '参加する',
      fn: function () { gotoJoin(inv); }
    });
  }
  function flushPendingInviteToast() {
    var inv = pendingInviteToast;
    pendingInviteToast = null;
    if (!inv) return;
    if (state.invites.indexOf(inv) < 0) return;     /* 参加・破棄済みなら出さない */
    if (Date.now() - (inv.ts || 0) > 25000) return; /* 古い招待は出さない */
    showInviteToastNow(inv);
  }

  /* スタイルとトースト置き場だけはゲート状態によらず用意する
     （ゲスト時の「ログインが必要です」案内にもトーストを使うため） */
  var shellBuilt = false;
  function buildShell() {
    if (shellBuilt) return;
    shellBuilt = true;
    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    els.toasts = document.createElement('div');
    els.toasts.className = 'pwf-toasts';
    document.body.appendChild(els.toasts);
  }
  function buildUI() {
    buildShell();
    htmlCache = {}; /* パネルDOMを作り直すので描画キャッシュは破棄 */
    /* ドロワー内マウント時は見出し行を出さない（ドロワー側に「👥 フレンド」がある） */
    var mount = document.getElementById('pwFriendsMount');
    var panelHtml =
      (mount ? '' :
      '<div class="pwf-head"><span>👥 フレンド</span>' +
      '<button class="pwf-x" id="pwfClose" aria-label="閉じる">✕</button></div>') +
      '<div class="pwf-note" id="pwfMeNote"></div>' +
      '<div id="pwfSearchSec" style="display:none">' +
      '<div class="pwf-sec">フレンドを追加</div>' +
      '<div class="pwf-row"><input class="pwf-input" id="pwfSearchName" maxlength="16" placeholder="相手のユーザー名" autocomplete="off" autocapitalize="none">' +
      '<button class="pwf-btn pri" id="pwfSearchBtn">検索</button></div>' +
      '<div class="pwf-note" id="pwfSearchNote"></div>' +
      '<div id="pwfSearchResult"></div>' +
      '</div>' +
      '<div id="pwfFriendReqs"></div>' +
      '<div id="pwfInvites"></div>' +
      '<div id="pwfListView">' +
        '<div class="pwf-sec">フレンド <span id="pwfCount"></span></div>' +
        '<div id="pwfList"></div>' +
        '<div class="pwf-note" id="pwfEmpty"></div>' +
      '</div>' +
      '<div id="pwfPickView" style="display:none">' +
        '<div class="pwf-row"><button class="pwf-btn" id="pwfPickBack">← もどる</button><b id="pwfPickTitle"></b></div>' +
        '<div id="pwfPickRoom" style="margin-top:10px"></div>' +
        '<div class="pwf-sec">ゲームを選んで招待（選ぶと部屋を作りに移動します）</div>' +
        '<div class="pwf-games" id="pwfPickGrid"></div>' +
      '</div>' +
      '<div class="pwf-note" id="pwfFootNote" style="margin-top:16px">フレンドの追加は、相手のユーザー名を検索して「フレンド申請」を送り、相手が承認するとフレンドになります。オンライン状態は相手がPlayWebを開いている時だけ分かります。招待はログイン中ならオフラインの相手にも届きます。</div>';

    if (mount) {
      inlineMode = true;
      mount.classList.add('pwf-root', 'pwf-indrawer');
      var inner = document.createElement('div');
      inner.className = 'pwf-panel';
      inner.innerHTML = panelHtml;
      mount.appendChild(inner);
      els.panel = inner;
    } else {
      /* account.js のドロワーが無いページ向けのフォールバック（右スライドパネル） */
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
    if (gateBlocked()) { loginNotice(); return; }
    /* 通常は account.js のアカウントドロワーを開く（パネルはその中にある） */
    if (window.PWAccount && window.PWAccount.openModal) {
      state.panelOpen = true;
      window.PWAccount.openModal();
      renderAll();
      return;
    }
    state.panelOpen = true;
    if (els.overlay) els.overlay.classList.add('show');
    renderAll();
  }
  function closePanel() {
    state.panelOpen = false;
    if (window.PWAccount && window.PWAccount.closeModal && inlineMode) {
      window.PWAccount.closeModal();
      return;
    }
    if (els.overlay) els.overlay.classList.remove('show');
    flushPendingInviteToast();
  }

  function bindPanelEvents() {
    if (!inlineMode) $('pwfClose').onclick = closePanel;
    $('pwfPickBack').onclick = function () { state.view = 'list'; state.pickFor = null; renderAll(); };
  }

  /* ---------- 描画 ---------- */
  /* 検索セクション（#pwfSearchSec）の表示は、パネルを描く側でも毎回同期する。
     以前は account.js の updateSearchRow() だけが表示切替を担っていたが、
     その呼び出しはポーリング（約10秒で打ち切り）と認証イベント時だけなので、
     パネルの構築がそれらより後になると（通信が遅い環境など）二度と表示されず、
     ドロワーを開いても検索欄が出ないまま固定される不具合があった。
     renderAll はパネル構築時・在席変化時・ドロワーを開く時などに必ず呼ばれる
     ので、ここで PWAccount のログイン状態と同期すれば自己完結する。
     ゲスト（未ログイン）では出さない（検索・申請はクラウド機能のため）。 */
  function renderSearchSec() {
    var sec = $('pwfSearchSec');
    if (!sec) return;
    var api = window.PWAccount;
    var active = !!(api && typeof api.cloudActive === 'function' && api.cloudActive());
    sec.style.display = active ? '' : 'none';
  }
  function renderAll() {
    if (!els.panel) return;
    renderSearchSec();
    renderProfile();
    renderFriendReqs();
    renderInvites();
    renderList();
    if (state.view === 'pick') renderPicker();
    if (pickerOpen) renderPickerList();
    if (recordsOpen) renderRecords();
    updateBadge();
  }
  /* パネル上部の自分の状態メモ（接続状態のみ。表示名の編集欄は廃止した） */
  function renderProfile() {
    var note = $('pwfMeNote');
    if (note) {
      if (state.unavailable) note.textContent = 'オンライン機能を読み込めませんでした（通信環境を確認してください）。フレンド機能は使えませんが、ゲームは遊べます。';
      else if (state.idTaken) note.textContent = 'このアカウントは別のタブ・端末で使用中です。そちらを閉じると、ここがオンラインになります。';
      else if (!state.peerOpen) note.textContent = '接続中…';
      else note.textContent = 'オンラインです。フレンドにはあなたの状態が見えます。';
    }
  }
  /* バッジは、共通ヘッダーのアカウントタブ（#pwTabBadge）に出す。
     ゲーム招待＋未処理のフレンド申請の件数を数える */
  function updateBadge() {
    var b = document.getElementById('pwTabBadge');
    if (!b) return;
    var n = state.invites.length + friendReqList.length;
    b.style.display = n > 0 ? 'flex' : 'none';
    b.textContent = n > 99 ? '99+' : String(n);
  }
  /* 自分宛のフレンド申請セクション（承認でフレンド化、断ると申請は消える） */
  function renderFriendReqs() {
    var box = $('pwfFriendReqs');
    if (!box) return;
    if (!friendReqList.length) { setHtmlCached(box, 'freqs', ''); return; }
    if (!setHtmlCached(box, 'freqs', '<div class="pwf-sec">フレンド申請が届いています</div>' + friendReqList.map(function (r) {
      return '<div class="pwf-invite"><b>' + esc(r.fromName || 'フレンド') + '</b> さんからフレンド申請が届いています' +
        '<div class="pwf-row" style="margin-top:8px"><button class="pwf-btn pri" data-freq-ok="' + esc(r.id) + '">承認</button>' +
        '<button class="pwf-btn" data-freq-no="' + esc(r.id) + '">断る</button></div></div>';
    }).join(''))) return; /* 内容が同じなら既存DOM・リスナーを維持 */
    box.querySelectorAll('[data-freq-ok]').forEach(function (btn) {
      btn.onclick = function () {
        btn.disabled = true;
        if (window.PWAccount && window.PWAccount.respondFriendRequest) {
          window.PWAccount.respondFriendRequest(btn.getAttribute('data-freq-ok'), true)
            .then(function () { renderAll(); });
        }
      };
    });
    box.querySelectorAll('[data-freq-no]').forEach(function (btn) {
      btn.onclick = function () {
        btn.disabled = true;
        if (window.PWAccount && window.PWAccount.respondFriendRequest) {
          window.PWAccount.respondFriendRequest(btn.getAttribute('data-freq-no'), false)
            .then(function () { renderAll(); });
        }
      };
    });
  }
  function renderInvites() {
    var box = $('pwfInvites');
    if (!box) return;
    if (!state.invites.length) { setHtmlCached(box, 'invites', ''); return; }
    if (!setHtmlCached(box, 'invites', '<div class="pwf-sec">届いている招待</div>' + state.invites.map(function (inv, i) {
      return '<div class="pwf-invite"><b>' + esc(inv.name) + '</b> さんから「' + esc(GAMES[inv.game].title) +
        '」への招待' +
        '<div class="pwf-row" style="margin-top:8px"><button class="pwf-btn pri" data-inv-join="' + i + '">参加する</button>' +
        '<button class="pwf-btn" data-inv-del="' + i + '">閉じる</button></div></div>';
    }).join(''))) return; /* 内容が同じなら既存DOM・リスナーを維持 */
    box.querySelectorAll('[data-inv-join]').forEach(function (btn) {
      btn.onclick = function () {
        var inv = state.invites[Number(btn.getAttribute('data-inv-join'))];
        if (inv) gotoJoin(inv);
      };
    });
    box.querySelectorAll('[data-inv-del]').forEach(function (btn) {
      btn.onclick = function () {
        var inv = state.invites[Number(btn.getAttribute('data-inv-del'))];
        if (inv && inv.cloudId && window.PWAccount && window.PWAccount.dismissInvite) {
          try { window.PWAccount.dismissInvite(inv.cloudId); } catch (e) {}
        }
        state.invites.splice(Number(btn.getAttribute('data-inv-del')), 1);
        renderAll();
      };
    });
  }
  function renderList() {
    var listEl = $('pwfList');
    if (!listEl) return;
    var lv = $('pwfListView'), pv = $('pwfPickView');
    if (lv) lv.style.display = state.view === 'list' ? '' : 'none';
    if (pv) pv.style.display = state.view === 'pick' ? '' : 'none';
    var cnt = $('pwfCount');
    if (cnt) cnt.textContent = '（' + friends.length + '人）';
    var empty = $('pwfEmpty');
    if (empty) empty.textContent = friends.length ? '' : 'まだフレンドがいません。上の「フレンドを追加」で相手のユーザー名を検索して申請を送りましょう。相手が承認するとフレンドになります。相手がPlayWebを開くと、ここにオンライン状態が表示されます。';
    if (!setHtmlCached(listEl, 'list', friends.map(function (f) {
      var on = isOnline(f.uid);
      var recSum = recordSummary(f.uid);
      var cp = cloudPresence[f.uid] || {};
      return '<div class="pwf-friend"><span class="pwf-avawrap">' + avatarHTML(f.uid, 38) +
        '<span class="pwf-dot' + (on ? ' on' : '') + '"></span></span>' +
        '<div class="pwf-fmeta" data-act="prof" data-uid="' + f.uid + '" title="タップでプロフィール"><div class="pwf-fname">' + esc(displayName(f.uid)) + '</div>' +
        (cp.comment ? '<div class="pwf-fcomment">' + esc(cp.comment) + '</div>' : '') +
        '<div class="pwf-fstat' + (on ? ' on' : '') + '">' + esc(presenceText(f.uid)) + '</div>' +
        (recSum ? '<div class="pwf-frec">' + esc(recSum) + '</div>' : '') + '</div>' +
        '<button class="pwf-iconbtn" data-act="pick" data-uid="' + f.uid + '"' + ((on || cloudActive()) ? '' : ' disabled style="opacity:.4"') + '>🎮</button>' +
        '<button class="pwf-iconbtn" data-act="del" data-uid="' + f.uid + '">✕</button></div>';
    }).join(''))) return; /* 内容が同じなら既存DOM・リスナーを維持 */
    listEl.querySelectorAll('[data-act]').forEach(function (btn) {
      btn.onclick = function () {
        var code = btn.getAttribute('data-uid'), act = btn.getAttribute('data-act');
        if (act === 'pick') {
          state.view = 'pick'; state.pickFor = code;
          renderAll();
        } else if (act === 'prof') {
          if (window.PWAccount && window.PWAccount.openProfile) window.PWAccount.openProfile(code);
        } else if (act === 'del') {
          if (!window.confirm(displayName(code) + 'さんをフレンドから削除しますか？')) return;
          friends = friends.filter(function (x) { return x.uid !== code; });
          var e = state.conns[code];
          if (e && e.conn) { try { e.conn.close(); } catch (err) {} }
          delete state.conns[code]; delete state.presence[code];
          saveFriends();
          renderAll();
        }
      };
    });
  }
  function renderPicker() {
    var code = state.pickFor;
    if (!code) return;
    $('pwfPickTitle').textContent = displayName(code) + 'さんを招待';
    var roomBox = $('pwfPickRoom');
    var room = (MY_GAME !== 'portal') ? currentRoomCode() : null;
    if (roomBox) {
      if (setHtmlCached(roomBox, 'pickRoom:' + code, room
        ? '<button class="pwf-btn pri" id="pwfPickRoomBtn" style="width:100%">🏠 いま開いている部屋に招待する</button>'
        : '')) {
      var rb = $('pwfPickRoomBtn');
      if (rb) rb.onclick = function () {
        startHostMatch(code);
        if (match && match.role === 'host' && match.game === MY_GAME) { match.room = room; saveMatch(); }
        if (sendInvite(code, MY_GAME, room)) {
          markInvited(code);
          toast(displayName(code) + 'さんに招待を送りました', 'info');
          state.view = 'list'; state.pickFor = null; renderAll();
        } else {
          toast('招待を送れませんでした（接続が切れています）', 'info');
        }
      };
      }
    }
    var grid = $('pwfPickGrid');
    if (grid) {
      if (setHtmlCached(grid, 'pickGrid:' + code, GAME_ORDER.filter(function (g) { return !(GAMES[g] && GAMES[g].noInvite); }).map(function (g) {
        return '<button class="pwf-game" data-game="' + g + '">' + esc(GAMES[g].title) + '</button>';
      }).join(''))) {
        grid.querySelectorAll('[data-game]').forEach(function (btn) {
          btn.onclick = function () {
            var g = btn.getAttribute('data-game');
            location.href = GAMES[g].file + '?hostinvite=' + encodeURIComponent(code);
          };
        });
      }
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
  /* ゲート未確定（pending/guest）の間に参加・招待ホストが要求された場合の
     再試行キュー。認証確定が遅い端末では、ブロックされた参加がそのまま
     消えて「?join で移動しても設定画面のまま」になるため、member 遷移時に
     applyGate から再実行する。 */
  var joinRetryCode = null;
  var hostInviteRetryUid = null;
  function runJoinHook(code) {
    if (gateBlocked()) { joinRetryCode = code; loginNotice(); return; }
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
  function runHostInviteHook(friendUid) {
    if (gateBlocked()) { hostInviteRetryUid = friendUid; return; }
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
        var room = currentRoomCode();
        if (room && sendInvite(friendUid, MY_GAME, room)) {
          if (match && match.role === 'host' && match.game === MY_GAME) { match.room = room; saveMatch(); }
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
  /* URL の ?join=<room>&from=<uid> からゲストの対戦コンテキストを立てる。
     initHooks（ゲート member 化時点）ではフレンド一覧のクラウド同期が
     まだ届いておらず friendOf(from) が失敗することがある（新規端末・
     キャッシュ消去後など）。その場合は諦めず、一覧が届いた時点
     （_cloud.setFriends / addFriend）や戦績記録の直前に再試行する。
     冪等：同じ対戦が既に立っていれば joinSent ごと保持し、相手が
     peers に居なければ補完だけ行う。ホスト対戦中のコンテキストは奪わない。 */
  function ensureJoinMatch() {
    var params;
    try { params = new URLSearchParams(location.search); } catch (e) { return false; }
    var join = params.get('join');
    if (!join) return false;
    var code = join.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, '').slice(0, 6);
    if (code.length !== 6) return false;
    /* 招待者（ホスト）の uid を引き継ぎ、対戦相手として保持する */
    var from = cleanUid(params.get('from') || '');
    if (!from) {
      try {
        var ctx = JSON.parse(sessionStorage.getItem('pw_join_ctx') || 'null');
        if (ctx && ctx.room === code) from = cleanUid(ctx.from || '');
      } catch (e) {}
    }
    if (from.length < 4 || !friendOf(from)) return false;
    if (match && match.game === MY_GAME && match.role === 'guest' && match.room === code) {
      if (match.peers.indexOf(from) < 0) addMatchPeer(from);
      trySendMatchJoin();
      return true;
    }
    if (match && match.game === MY_GAME && match.role === 'host') return false;
    setMatch({ game: MY_GAME, role: 'guest', room: code, peers: [from], joinSent: false });
    trySendMatchJoin();
    return true;
  }
  /* ?hostinvite=<uid> 側も同じ競合（ゲート時点では一覧未同期）があるため、
     一覧到着後に再試行できる形にする。開始済みなら二重実行しない。 */
  function ensureHostInviteMatch() {
    if (window.PW_HOSTINVITE_STARTED) return false;
    var params;
    try { params = new URLSearchParams(location.search); } catch (e) { return false; }
    var hi = params.get('hostinvite');
    if (!hi) return false;
    var fc = cleanUid(decodeURIComponent(hi));
    if (fc.length < 4 || !friendOf(fc)) return false;
    startHostMatch(fc);
    runHostInviteHook(fc);
    return true;
  }
  /* フレンド一覧が（再）同期されたタイミングで、未確定の対戦コンテキストを回収する */
  function retryPendingMatch() {
    if (gateBlocked()) return;
    ensureJoinMatch();
    ensureHostInviteMatch();
  }
  function initHooks() {
    var params;
    try { params = new URLSearchParams(location.search); } catch (e) { return; }
    var join = params.get('join');
    if (join) {
      var code = join.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, '').slice(0, 6);
      if (code.length === 6) {
        ensureJoinMatch();
        runJoinHook(code); return;
      }
    }
    if (params.get('hostinvite')) {
      ensureHostInviteMatch();
    }
  }

  /* ---------------- ゲート（ログイン必須化 / account.js 連携） ----------------
     ゲスト（未ログイン）・SDK が読み込めない環境では、フレンド機能と
     マルチプレイの入口を一切出さない。account.js が gateState
     （pending/member/guest/sdk-down）を通知してくるので、それに従う。
     account.js が無いページでは従来動作（member 扱い）。 */
  var gateState = 'pending';
  var fullInitDone = false;
  function gateBlocked() { return gateState !== 'member'; }
  function loginNotice() {
    if (gateState === 'sdk-down') {
      toast('ログイン機能を読み込めない環境では、オンライン対戦・フレンド機能は使えません', 'info');
      return;
    }
    if (gateState === 'pending') {
      toast('ログイン状態を確認しています…', 'info');
      return;
    }
    toast('オンライン対戦・フレンド機能にはログインが必要です', 'info');
    if (window.PWAccount && window.PWAccount.openModal) window.PWAccount.openModal();
  }
  function teardownFriendsUI() {
    htmlCache = {}; /* パネルDOMを破棄するので描画キャッシュも破棄 */
    try { closePanel(); } catch (e) {}
    closeInvitePicker();
    closeRecords();
    if (els.panel && els.panel.parentNode) els.panel.parentNode.removeChild(els.panel);
    els.panel = null;
    if (els.overlay && els.overlay.parentNode) els.overlay.parentNode.removeChild(els.overlay);
    els.overlay = null;
    document.querySelectorAll('.pwf-gamebar').forEach(function (b) { b.remove(); });
    try { if (state.peer) state.peer.destroy(); } catch (e) {}
    state.peer = null; state.peerOpen = false; state.conns = {}; state.presence = {};
  }
  var hooksNoticeShown = false;
  function initHooksBlockedNotice() {
    if (hooksNoticeShown) return;
    try {
      var params = new URLSearchParams(location.search);
      if (params.get('join') || params.get('hostinvite')) {
        hooksNoticeShown = true;
        loginNotice();
      }
    } catch (e) {}
  }
  function applyGate(state) {
    gateState = state || 'guest';
    if (gateState === 'member') {
      if (!fullInitDone) {
        fullInitDone = true;
        buildUI();
        startPeerWhenReady();
        initHooks();
        setInterval(trySendMatchJoin, 4000);
      } else {
        if (!els.panel) buildUI();
        if (!state.peer) startPeerWhenReady();
        /* 再試行: ゲート未確定の間にブロックされた参加/招待ホスト要求や、
           member→guest→member の teardown サイクルで initHooks が再実行
           されないケースを、認証確定のたびに回収する。開始済みフラグが
           立っているものは二重実行しない。 */
        if (joinRetryCode && !window.PW_JOIN_STARTED) {
          var rc = joinRetryCode; joinRetryCode = null;
          runJoinHook(rc);
        } else if (hostInviteRetryUid && !window.PW_HOSTINVITE_STARTED) {
          var hu = hostInviteRetryUid; hostInviteRetryUid = null;
          if (friendOf(hu)) { startHostMatch(hu); runHostInviteHook(hu); }
        } else if (!window.PW_JOIN_STARTED && !window.PW_HOSTINVITE_STARTED) {
          try {
            var p = new URLSearchParams(location.search);
            if (p.get('join') || p.get('hostinvite')) initHooks();
          } catch (e) {}
        }
      }
      initGameUI();
    } else {
      if (fullInitDone) teardownFriendsUI();
      initGameUI();
      initHooksBlockedNotice();
    }
  }
  /* PW_AUTO_HOST / PW_AUTO_JOIN はゲートを見るラッパとして用意する
     （ゲーム側が独自に定義している場合はそちらを尊重する） */
  function defineAutoHooks() {
    if (MY_GAME === 'portal' || !window.PW_JOIN_CFG) return;
    if (typeof window.PW_AUTO_HOST !== 'function') {
      window.PW_AUTO_HOST = function () {
        if (gateBlocked()) { loginNotice(); return; }
        autoHostViaCfg();
      };
    }
    if (typeof window.PW_AUTO_JOIN !== 'function') {
      window.PW_AUTO_JOIN = function (room) {
        /* ブロック時は runJoinHook 側で再試行キュー＋案内まで行う */
        runJoinHook(room);
      };
    }
  }
  /* ゲスト時のオンライン入口クリック遮断（capture フェーズ）:
     ゲーム独自の入口が画面に残っていても、押した時点で止めて案内を出す */
  document.addEventListener('click', function (e) {
    if (!gateBlocked() || MY_GAME === 'portal') return;
    var cfg = window.PW_JOIN_CFG;
    if (!cfg) return;
    var sels = [];
    (cfg.openers || []).forEach(function (op) { if (op.click) sels.push(op.click); });
    if (cfg.hostBtn) sels.push(cfg.hostBtn);
    if (cfg.joinBtn) sels.push(cfg.joinBtn);
    for (var i = 0; i < sels.length; i++) {
      var hit = null;
      try { hit = (e.target && e.target.closest) ? e.target.closest(sels[i]) : null; } catch (err) {}
      if (hit) {
        e.preventDefault();
        e.stopPropagation();
        loginNotice();
        return;
      }
    }
  }, true);

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
    buildShell();
    defineAutoHooks();
    if (window.PWAccount && typeof window.PWAccount.gateState === 'function') {
      /* アカウント基盤がある場合はゲート判定に従う（判定が出るまでフレンドUIは出さない） */
      var gs = window.PWAccount.gateState();
      if (gs && gs !== 'pending') applyGate(gs);
      window.PWAccount.onGateChange(function (s) { applyGate(s); });
      if (window.PWAccount._friendsReady) window.PWAccount._friendsReady();
      /* 判定が来ない場合の保険（account.js は SDK 失敗時も必ず通知するが念のため） */
      setTimeout(function () { if (gateState === 'pending') applyGate('sdk-down'); }, 25000);
    } else {
      /* account.js が無いページでは従来動作 */
      applyGate('member');
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
