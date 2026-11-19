/* ============================================================
   PlayWeb アカウント基盤（account.js）
   ------------------------------------------------------------
   Firebase（Auth + Firestore）を使った共通モジュール。
   全ページの <head> 内（ゲーム本体のスクリプトより前）に
   <script src="account.js"> で組み込む。ゲスト制限の保存シムを
   ゲームの初期化より先に有効化するため、末尾ではなく head に置く。

   提供するもの:
   - ログイン管理: ユーザー名＋パスワード（Auth はメール/パスワード方式のため、
     ユーザー名を "<username>@playweb.local" に変換して使う）
   - プロフィール: Firestore users/{uid}（公開: username, usernameLower,
     online, lastSeen, currentGame, createdAt）
     usernames/{usernameLower} -> {uid}（重複防止・検索用）
     ※ v51〜 フレンドコード方式は廃止。フレンドの同一性は uid で統一し、
       追加はユーザー名検索のみ。codes コレクションは使わない（ルールは不変）。
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
   - ゲスト制限（v50〜）: 未ログイン（ゲスト）は1人用モードのみ。
     マルチプレイ・フレンド機能は使えず、セーブデータは保存されない。
     実装は2層: (1) 保存シム — ログイン見込みが無いページ読み込みでは、
     ゲーム系キーへの localStorage 読み書きをメモリ内ストアへ振り替える。
     ディスク上の既存データは絶対に削除・上書きしない（見せないだけ）。
     ログイン痕跡（pwacct_hint）は前回セッションのものを参照する。
     (2) ゲート — friends.js へ gateState（pending/member/guest/sdk-down）を
     通知し、フレンドUI・招待・オンライン入口を制御する。SDK が読み込めない
     環境ではログインできないため、マルチ/フレンドはゲスト扱いでブロックし、
     セーブはディスクを触らない（シムはディスクを消さない）。
   - v50 移行: フレンド系ローカルデータ（playweb_friends/chats/unread/records）は
     初回起動時に一度だけリセットする（ユーザー許可済み）。ゲームのセーブには
     一切触らない。プロフィール（名前）は残す。
   - 共通ヘッダー＋ドロワー（v51〜）: 全ページ最上部に共通ヘッダー
     （🏠ホーム＋ゲーム名＋[メイン｜アカウント]タブ）を注入する。
     「アカウント」タブで右から半透明ドロワーがスライドインし、
     ログイン/登録/ログアウトとフレンド機能（friends.js が #pwFriendsMount
     にマウント）を集約表示する。旧・左下ピルとログインモーダル、
     friends.js の右下 FAB は廃止。PWAccount.openModal() はドロワーを開く。
   - v52〜 リアルタイム化の仕上げ＋プロフィール＋フィードバック:
     在席/チャット/招待は Firestore の onSnapshot 購読で即時反映する
     （ハートビートは30秒のまま。購読が即時化の本命で、間隔短縮は
     書き込み量と電池の無駄が大きい）。タブを隠す/閉じると即オフライン化。
     プロフィール: users/{uid} に iconId / iconColor / comment /
     stats（ゲーム別戦績の集計）/ mainChar（リンクサーガの使用キャラ）を
     持たせ、ドロワーとフレンド一覧・プロフィール画面で表示する。
     フィードバック: feedback コレクションへ誰でも送信可（ゲストの
     不具合報告経路を塞がない）。管理者（ADMIN_UIDS）だけがドロワー内の
     意見ボックスで読める。本番ルールへの feedback 追加はユーザーの
     再貼り付け待ち（firestore.rules に追記済み）。

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
  /* 管理者 uid のリスト（意見ボックスの表示・読み取りに使う）。
     ★管理者アカウントを作ったら、ここにその uid を入れること。
       uid の確認方法: (1) Firebase コンソール → Authentication → Users の
       「User UID」欄。(2) 管理者アカウントでログインした状態で、ブラウザの
       コンソールで PWAccount.user().uid を実行する。
     ★firestore.rules 側の adminUids() のプレースホルダにも同じ uid を
       入れないと、本番では意見ボックスの読み取りがルールで拒否される。 */
  var ADMIN_UIDS = ['9FompVx7Gpfp2f2anoz35vPyD6F3'];
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

  /* ---------------- 生ストレージ（シムを通さない直接アクセス） ----------------
     ゲスト用シムは Storage.prototype を差し替えるため、account.js 自身が
     ディスク上の実データへ触るときは、差し替え前の原生メソッドを使う。 */
  var rawLS = { get: null, set: null, remove: null, clear: null };
  try {
    var __proto = window.Storage && Storage.prototype;
    if (__proto) {
      rawLS.get = __proto.getItem; rawLS.set = __proto.setItem;
      rawLS.remove = __proto.removeItem; rawLS.clear = __proto.clear;
    }
  } catch (e) {}
  function diskGet(k) {
    try { return rawLS.get ? rawLS.get.call(window.localStorage, k) : null; }
    catch (e) { return null; }
  }
  function diskSet(k, v) {
    try { if (rawLS.set) rawLS.set.call(window.localStorage, k, String(v)); } catch (e) {}
  }
  function diskRemove(k) {
    try { if (rawLS.remove) rawLS.remove.call(window.localStorage, k); } catch (e) {}
  }
  /* シムの対象外キー（常にディスク直通）:
     - firebase: で始まるキー（Firebase Auth の永続化を壊さない）
     - pwacct_ で始まるキー（account.js の内部管理キー）
     - playweb_pre_import_backup（退避データ） */
  var LS_STASH_EARLY = 'playweb_pre_import_backup';
  function shimExempt(k) {
    return k === LS_STASH_EARLY || k.indexOf('firebase:') === 0 || k.indexOf('pwacct_') === 0;
  }

  /* ---------------- ログイン痕跡（ヒント）とゲスト状態 ----------------
     pwacct_hint: {loggedIn: bool, ts} — 前回セッションで認証が確定した時点の状態。
     ページ読み込み時点では Firebase の認証状態はまだ分からないため、
     「前回ログインしていた」場合だけシムを無効にして読み込みを始める。
     認証が確定したら onAuthUser 側で整合させる（必要なら再読み込み）。 */
  var LS_HINT = 'pwacct_hint';
  function readHint() {
    try {
      var h = JSON.parse(diskGet(LS_HINT) || 'null');
      return (h && typeof h === 'object') ? h : null;
    } catch (e) { return null; }
  }
  function writeHint(loggedIn) {
    diskSet(LS_HINT, JSON.stringify({ loggedIn: !!loggedIn, ts: nowMs() }));
  }
  var hintAtLoad = readHint();
  /* ゲストシムが有効か。有効な間、ゲーム系キーへの読み書きは memStore 行きで、
     ディスク上の既存データは見えなくなる（削除・上書きは一切しない）。 */
  var guestActive = !(hintAtLoad && hintAtLoad.loggedIn === true);
  var memStore = {};   /* key -> string（ゲストセッション内だけの保存先） */

  /* ゲート状態: friends.js のフレンド/マルチ制御に使う
     pending（認証確認中）| member（ログイン中）| guest（未ログイン）| sdk-down（SDK不可） */
  var gateState = 'pending';
  var gateCbs = [];
  function setGate(state) {
    gateState = state;
    pushGateToFriends();
    gateCbs.slice().forEach(function (cb) { try { cb(state); } catch (e) {} });
    applyMemberOnlyVisibility();
  }
  function pushGateToFriends() {
    var api = window.PWFriends;
    if (api && api._applyGate) { try { api._applyGate(gateState); } catch (e) {} }
  }
  /* ポータル等の「ログイン中だけ見せる要素」「ゲスト向け案内」の表示切替 */
  function applyMemberOnlyVisibility() {
    try {
      var member = gateState === 'member';
      var guestish = gateState === 'guest' || gateState === 'sdk-down';
      document.querySelectorAll('[data-pw-member-only]').forEach(function (el) {
        el.style.display = member ? '' : 'none';
      });
      document.querySelectorAll('[data-pw-guest-note]').forEach(function (el) {
        el.style.display = guestish ? '' : 'none';
      });
    } catch (e) {}
  }

  /* 遷移時の自動リロードは1回だけ（ループ防止）。安定状態で解除する */
  function reloadOnce(tag) {
    try {
      if (sessionStorage.getItem('pwacct_rl') === tag) return false;
      sessionStorage.setItem('pwacct_rl', tag);
    } catch (e) {}
    location.reload();
    return true;
  }
  function clearReloadGuard() {
    try { sessionStorage.removeItem('pwacct_rl'); } catch (e) {}
  }

  /* ゲスト中の進捗をディスクへ移す（新規登録時専用）。
     安全条件: ディスクに既にあるキーはディスク側が正。シム側の値は
     「ディスクに無いキー」に限って書き足す（ゲームが起動時に書いた
     初期値などで本物のセーブを潰さないため）。 */
  function flushGuestStoreDiskFirst() {
    if (!guestActive) return;
    Object.keys(memStore).forEach(function (k) {
      if (shimExempt(k)) return;
      if (diskGet(k) === null) diskSet(k, memStore[k]);
    });
    memStore = {};
    guestActive = false;
  }

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
        return 'このユーザー名は既に登録されています。心当たりがあればログインしてみてください';
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

  /* ---------------- プロフィール（v52〜） ----------------
     users/{uid} の公開フィールドとして iconId / iconColor / comment /
     stats / mainChar を持つ。アイコンはプリセット（SVG描画）から選び、
     保存するのは iconId と iconColor（色ID）だけ。画像アップロードはしない。 */
  var PROFILE_COLORS = [
    { id: 'violet', c: '#a78bfa' }, { id: 'sky', c: '#38bdf8' },
    { id: 'pink', c: '#f472b6' }, { id: 'mint', c: '#34d399' },
    { id: 'amber', c: '#f59e0b' }, { id: 'red', c: '#ef4444' },
    { id: 'indigo', c: '#818cf8' }, { id: 'gray', c: '#94a3b8' }
  ];
  var PROFILE_COLOR_MAP = {};
  PROFILE_COLORS.forEach(function (x) { PROFILE_COLOR_MAP[x.id] = x.c; });
  var PROFILE_ICONS = [
    { id: 'cat', label: 'ねこ', svg: '<path d="M5.4 3.6l2.8 1.7C9.4 4.8 10.7 4.5 12 4.5s2.6.3 3.8.8l2.8-1.7-.5 3.9c.4 1 .6 2 .6 3.1a7.7 7.7 0 1 1-15.4 0c0-1.1.2-2.1.6-3.1l-.5-3.9z"/><circle cx="9" cy="12.8" r="1.25" fill="rgba(0,0,0,.45)"/><circle cx="15" cy="12.8" r="1.25" fill="rgba(0,0,0,.45)"/>' },
    { id: 'paw', label: 'にくきゅう', svg: '<ellipse cx="12" cy="15.8" rx="4.6" ry="3.9"/><circle cx="5.4" cy="10.8" r="1.9"/><circle cx="9.2" cy="7.9" r="2.05"/><circle cx="14.8" cy="7.9" r="2.05"/><circle cx="18.6" cy="10.8" r="1.9"/>' },
    { id: 'star', label: 'ほし', svg: '<path d="M12 2.2l2.9 6.2 6.8.8-5 4.6 1.3 6.7L12 17.1l-6 3.4 1.3-6.7-5-4.6 6.8-.8z"/>' },
    { id: 'moon', label: 'つき', svg: '<path d="M20.8 13.2A8.8 8.8 0 1 1 10.8 3.2a7.2 7.2 0 0 0 10 10z"/>' },
    { id: 'sun', label: 'たいよう', svg: '<circle cx="12" cy="12" r="4.6"/><g stroke="currentColor" stroke-width="2.1" stroke-linecap="round" fill="none"><path d="M12 2.5v2.6M12 18.9v2.6M2.5 12h2.6M18.9 12h2.6M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8"/></g>' },
    { id: 'heart', label: 'ハート', svg: '<path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>' },
    { id: 'flower', label: 'はな', svg: '<circle cx="12" cy="6.8" r="3.1"/><circle cx="17" cy="10.4" r="3.1"/><circle cx="15" cy="16.4" r="3.1"/><circle cx="9" cy="16.4" r="3.1"/><circle cx="7" cy="10.4" r="3.1"/><circle cx="12" cy="11.8" r="2.1" fill="rgba(0,0,0,.35)"/>' },
    { id: 'crown', label: 'おうかん', svg: '<path d="M3 7.5l4.6 3.6L12 5l4.4 6.1L21 7.5 19.6 17H4.4L3 7.5z"/><path d="M4.5 19h15v2h-15z"/>' },
    { id: 'ghost', label: 'おばけ', svg: '<path d="M12 2.8a7.2 7.2 0 0 1 7.2 7.2v9.4l-2.4-1.8-2.4 1.8-2.4-1.8-2.4 1.8-2.4-1.8L4.8 19.4V10A7.2 7.2 0 0 1 12 2.8z"/><circle cx="9.2" cy="10.5" r="1.3" fill="rgba(0,0,0,.45)"/><circle cx="14.8" cy="10.5" r="1.3" fill="rgba(0,0,0,.45)"/>' },
    { id: 'rocket', label: 'ロケット', svg: '<path d="M12 1.8c2.9 2.3 4.6 6.2 4.6 10.2l3.1 3.6-4.2.5c-.8 1.8-2 3.2-3.5 4.2-1.5-1-2.7-2.4-3.5-4.2l-4.2-.5L7.4 12C7.4 8 9.1 4.1 12 1.8z"/><circle cx="12" cy="9.5" r="2.1" fill="rgba(0,0,0,.4)"/>' },
    { id: 'note', label: 'おんぷ', svg: '<path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>' },
    { id: 'gamepad', label: 'ゲーム', svg: '<path d="M7.5 7h9A5.5 5.5 0 0 1 22 12.5c0 3-2.5 5.5-5.5 5.5-1.3 0-2.5-.45-3.4-1.2l-1.2-1.2a.6.6 0 0 0-.8 0l-1.2 1.2c-.9.75-2.1 1.2-3.4 1.2A5.5 5.5 0 0 1 1.5 12.5 5.5 5.5 0 0 1 7.5 7z"/><path d="M7 10v4M5 12h4" stroke="rgba(0,0,0,.45)" stroke-width="1.7" stroke-linecap="round" fill="none"/><circle cx="16.4" cy="11" r="1.15" fill="rgba(0,0,0,.45)"/><circle cx="18.6" cy="13.4" r="1.15" fill="rgba(0,0,0,.45)"/>' },
    { id: 'gem', label: 'ほうせき', svg: '<path d="M6.2 3h11.6L21 8.4 12 21 3 8.4 6.2 3z"/><path d="M3.6 8.4h16.8M9.2 3L7 8.4 12 19l5-11.6L14.8 3" fill="none" stroke="rgba(0,0,0,.35)" stroke-width="1.1"/>' },
    { id: 'cloud', label: 'くも', svg: '<path d="M6.8 18.5h9.7a4.6 4.6 0 0 0 .9-9.1 6.2 6.2 0 0 0-11.9 1.4 4 4 0 0 0 1.3 7.7z"/>' },
    { id: 'leaf', label: 'はっぱ', svg: '<path d="M4.6 19.4C4.6 10.8 10.8 4.6 19.4 4.6c0 8.6-6.2 14.8-14.8 14.8z"/><path d="M4.6 19.4c1.8-5 5.4-9.3 10-11.9" fill="none" stroke="rgba(0,0,0,.35)" stroke-width="1.2"/>' },
    { id: 'bell', label: 'ベル', svg: '<path d="M12 2.6a6 6 0 0 1 6 6c0 3.8 1 5.4 2 6.9H4c1-1.5 2-3.1 2-6.9a6 6 0 0 1 6-6z"/><path d="M9.6 18.2h4.8a2.45 2.45 0 0 1-4.8 0z"/>' },
    { id: 'planet', label: 'わくせい', svg: '<circle cx="12" cy="12" r="5.6"/><ellipse cx="12" cy="12" rx="10.2" ry="3.1" fill="none" stroke="currentColor" stroke-width="1.7" transform="rotate(-16 12 12)"/>' },
    { id: 'bolt', label: 'かみなり', svg: '<path d="M13.2 2L5 13.2h5.4L9.2 22l8.2-11.2h-5.4L13.2 2z"/>' },
    { id: 'snow', label: 'ゆき', svg: '<g stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"><path d="M12 3v18M4.5 7.5l15 9M19.5 7.5l-15 9"/></g><circle cx="12" cy="12" r="1.6"/>' },
    { id: 'mushroom', label: 'きのこ', svg: '<path d="M12 3.5C7.2 3.5 3.2 7.3 3.2 12h17.6c0-4.7-4-8.5-8.8-8.5z"/><circle cx="8.6" cy="8.2" r="1.5" fill="rgba(255,255,255,.75)"/><circle cx="14.8" cy="7.2" r="1.15" fill="rgba(255,255,255,.75)"/><path d="M9.3 12h5.4l.7 5.6a3.4 3.4 0 0 1-6.8 0L9.3 12z"/>' },
    { id: 'fish', label: 'さかな', svg: '<path d="M2.2 12c2.3-3.9 5.7-6.3 9.8-6.3 2.9 0 5.4 1.2 7.3 3.2L22 5.4v13.2l-2.7-3.3C17.4 17.3 14.9 18.5 12 18.5 7.9 18.5 4.5 16 2.2 12z"/><circle cx="8" cy="10.8" r="1.3" fill="rgba(0,0,0,.45)"/>' }
  ];
  var PROFILE_ICON_MAP = {};
  PROFILE_ICONS.forEach(function (x) { PROFILE_ICON_MAP[x.id] = x; });
  /* アイコンの HTML（p = {iconId, iconColor, name}）。未設定なら頭文字。
     friends.js からも PWAccount.profileIcon として使う（CSS は account.js 側） */
  function profileIconHTML(p, size) {
    p = p || {};
    var s = size || 36;
    var col = PROFILE_COLOR_MAP[p.iconColor] || PROFILE_COLOR_MAP.violet;
    var ic = PROFILE_ICON_MAP[p.iconId];
    var inner;
    if (ic) {
      inner = '<svg viewBox="0 0 24 24" width="' + Math.round(s * 0.72) + '" height="' + Math.round(s * 0.72) + '" fill="currentColor" aria-hidden="true">' + ic.svg + '</svg>';
    } else {
      var initial = String(p.name || '?').trim().slice(0, 1) || '?';
      inner = '<span style="font-weight:900;font-size:' + Math.round(s * 0.44) + 'px;line-height:1">' + esc(initial) + '</span>';
    }
    return '<span class="pwa-ava" style="width:' + s + 'px;height:' + s + 'px;background:' + col + '">' + inner + '</span>';
  }
  /* lastSeen の相対表示（d = {online, lastSeen}） */
  function relLastSeenText(d) {
    if (!d) return 'オフライン';
    var fresh = d.lastSeen && (nowMs() - d.lastSeen < PRESENCE_STALE_MS);
    if (d.online && fresh) return 'オンライン中';
    if (!d.lastSeen) return 'オフライン';
    var diff = nowMs() - d.lastSeen;
    if (diff < 90000) return 'たった今までオンライン';
    if (diff < 3600000) return Math.max(1, Math.floor(diff / 60000)) + '分前までオンライン';
    if (diff < 86400000) return Math.floor(diff / 3600000) + '時間前までオンライン';
    if (diff < 2 * 86400000) return '昨日までオンライン';
    return Math.floor(diff / 86400000) + '日前までオンライン';
  }
  /* 自分のゲーム別戦績を playweb_records から集計する（対戦相手の内訳は出さない）。
     戻り値: { gameId: {w, l, d, p(プレイ数), c(クリア数)} }（プレイのあるゲームのみ） */
  function computeMyStats() {
    var out = {};
    try {
      var rec = JSON.parse(localStorage.getItem('playweb_records') || '{}');
      if (!rec || typeof rec !== 'object') return out;
      Object.keys(rec).forEach(function (uid) {
        var byGame = rec[uid];
        if (!byGame || typeof byGame !== 'object') return;
        Object.keys(byGame).forEach(function (g) {
          if (g === '_name') return;
          var r = byGame[g];
          if (!r || !r.plays) return;
          var o = out[g] || (out[g] = { w: 0, l: 0, d: 0, p: 0, c: 0 });
          o.w += r.w || 0; o.l += r.l || 0; o.d += r.d || 0;
          o.p += r.plays || 0; o.c += r.clears || 0;
        });
      });
    } catch (e) {}
    return out;
  }
  /* リンクサーガ（linksaga）の使用キャラ名をセーブから読む。
     セーブ形式: { fav: キャラid, party: [id...], owned: {id: {lv, lb}} }
     優先順: お気に入り(fav) → 編成の先頭 → 最もレベルの高い所持キャラ。
     名前が引けない id（未登録のもの）は表示しない（空文字を返す）。
     ※ id→名前の対応は linksaga のロスター全26体分（v54 で SR/R を含め完成） */
  var LS_CHAR_NAMES = {
    astraia: 'アストライア', velzelia: 'ヴェルゼリア', seiren: 'セイレーン',
    blaze: 'ブレイズ', gracia: 'グラキエス', terra: 'テラ', solaris: 'ソラリス', nox: 'ノクス',
    hibana: 'ヒバナ', momiji: 'モミジ', umineko: 'ウミネコ', kohaku: 'コハク',
    wakaba: 'ワカバ', tsurugi: 'ツルギ', lux: 'ルクス', yomi: 'ヨミ',
    mike: 'ミケ', chatra: 'チャトラ', saba: 'サバ', yuki: 'ユキ', hachi: 'ハチ',
    mint: 'ミント', shiro: 'シロ', tama: 'タマ', kuro: 'クロ', yoru: 'ヨル'
  };
  function readMainChar() {
    try {
      var s = JSON.parse(localStorage.getItem('linksaga_save_v1') || 'null');
      if (!s || typeof s !== 'object') return '';
      var id = '';
      if (typeof s.fav === 'string' && s.fav) id = s.fav;
      else if (Array.isArray(s.party) && typeof s.party[0] === 'string' && s.party[0]) id = s.party[0];
      else if (s.owned && typeof s.owned === 'object') {
        var best = -1;
        Object.keys(s.owned).forEach(function (k) {
          var lv = (s.owned[k] && s.owned[k].lv) || 0;
          if (lv > best) { best = lv; id = k; }
        });
      }
      return LS_CHAR_NAMES[id] || '';
    } catch (e) { return ''; }
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
  /* 自分のプロフィール拡張フィールド（users/{uid} と同期する分） */
  var myProfile = { iconId: '', iconColor: '', comment: '', stats: null, mainChar: '' };
  var lastExtrasJson = '';    /* stats/mainChar の publish 済み内容（無駄な書き込み防止） */
  var extrasTimer = null;

  function cloudActive() { return !!(me && servicesOn && fb); }

  /* ---------------- 同期メタ（localStorage） ----------------
     pwacct_meta: {
       keys: { <lskey>: {h: ハッシュ, t: 最終変更/同期時刻ms, del: 削除済みか} },
       chatSeen: { <相手uid>: 取り込み済みチャットの最大ts },
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

  /* ---------------- v50 移行: フレンド系ローカルデータの1回リセット ----------------
     ユーザー許可済み。対象は playweb_friends / playweb_chats / playweb_unread /
     playweb_records のみ。ゲームのセーブ・プロフィール（名前/自分のコード）には
     一切触らない。ディスク直接操作なのでゲストシムの有無に影響されない。
     - 戦績（playweb_records）はクラウドセーブ同期対象でもあるため、削除を
       メタにも刻んでおく（次回同期でクラウド側へも削除が伝わり、復活しない）。
     - ログイン中ユーザーのフレンド一覧は Firestore 側が正なので、初回の
       サービス開始時に「クラウドをローカルへマージ」ではなく、リセット後の
       ローカル状態でクラウドを上書きする（meta.friendsResetPending）。
       ただしクラウド側が移行より後に更新されていたら（別端末で登録し直した等）
       そちらを正として上書きしない。
     - チャットは移行時刻以前のクラウドメッセージを取り込まない
       （meta.friendsResetAt を境界にする）。 */
  var LS_FRIENDS_RESET = 'pwacct_friends_reset_v50';
  (function friendsResetMigration() {
    try {
      if (diskGet(LS_FRIENDS_RESET)) return;
      /* チャットの取り込み境界は「実際に履歴があって消した場合」にだけ意味がある。
         履歴が無かった端末では境界を置かず、クラウドの履歴を通常どおり取り込む */
      var hadChats = false;
      try {
        var c = diskGet('playweb_chats');
        if (c && c.length > 2) hadChats = true;
      } catch (e) {}
      ['playweb_friends', 'playweb_chats', 'playweb_unread', 'playweb_records'].forEach(function (k) {
        diskRemove(k);
      });
      var t = nowMs();
      meta.keys['playweb_records'] = { h: '', t: t, del: true };
      meta.friendsResetPending = true;
      meta.friendsResetAt = t;
      meta.chatResetAt = hadChats ? t : 0;
      saveMetaNow();
      diskSet(LS_FRIENDS_RESET, '1');
    } catch (e) {}
  })();

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
    if (guestActive) {
      /* ゲスト中はメモリ内ストアが「ローカル」の実体（ディスクは見ない） */
      Object.keys(memStore).forEach(function (k) {
        if (syncableKey(k)) data[k] = memStore[k];
      });
      return data;
    }
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
    /* 戦績・リンクサーガのセーブが変わったらプロフィール集計の再 publish を予約 */
    if (key === 'playweb_records' || key === 'linksaga_save_v1') schedulePublishExtras();
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
      var origGet = proto.getItem, origSet = proto.setItem,
          origRemove = proto.removeItem, origClear = proto.clear;
      proto.getItem = function (k) {
        if (this === window.localStorage && guestActive && !shimExempt(String(k))) {
          var key = String(k);
          return Object.prototype.hasOwnProperty.call(memStore, key) ? memStore[key] : null;
        }
        return origGet.apply(this, arguments);
      };
      proto.setItem = function (k, v) {
        if (this === window.localStorage && guestActive && !shimExempt(String(k))) {
          /* ゲストの保存はメモリ内だけ。ディスクには一切触らない */
          memStore[String(k)] = String(v);
          return undefined;
        }
        var r = origSet.apply(this, arguments);
        try { if (this === window.localStorage) onLocalWrite(String(k), String(v)); } catch (e) {}
        return r;
      };
      proto.removeItem = function (k) {
        if (this === window.localStorage && guestActive && !shimExempt(String(k))) {
          delete memStore[String(k)];
          return undefined;
        }
        var r = origRemove.apply(this, arguments);
        try { if (this === window.localStorage) onLocalRemove(String(k)); } catch (e) {}
        return r;
      };
      proto.clear = function () {
        if (this === window.localStorage && guestActive) {
          /* ゲストの clear はメモリ内だけ（ディスクを消す事故を防ぐ） */
          memStore = {};
          return undefined;
        }
        return origClear.apply(this, arguments);
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

  /* ---------------- フレンド基盤（Firestore） ----------------
     v51〜 フレンドの同一性は uid。エントリ形式は {uid, username, addedAt}。
     旧形式（code キー）のエントリは同一視できず読み捨てる（v50 のリセットで
     実質残っていない前提）。 */
  function pwf() { return window.PWFriends || null; }
  function localFriends() {
    try {
      var f = JSON.parse(localStorage.getItem('playweb_friends') || '[]');
      return Array.isArray(f) ? f.filter(function (x) { return x && typeof x.uid === 'string'; }) : [];
    } catch (e) { return []; }
  }
  function friendsListHash(list) {
    var norm = list.map(function (f) {
      return [f.uid, f.username || ''].join('|');
    }).sort().join(';');
    return hashStr(norm);
  }
  function mergeFriends(local, cloud) {
    var byUid = {};
    (cloud || []).forEach(function (f) { if (f && f.uid) byUid[f.uid] = f; });
    (local || []).forEach(function (f) {
      if (!f || !f.uid) return;
      var c = byUid[f.uid];
      if (!c) { byUid[f.uid] = f; return; }
      byUid[f.uid] = {
        uid: f.uid,
        username: c.username || f.username || '',
        addedAt: Math.min(c.addedAt || Infinity, f.addedAt || Infinity)
      };
      if (byUid[f.uid].addedAt === Infinity) byUid[f.uid].addedAt = Date.now();
    });
    return Object.keys(byUid).map(function (k) { return byUid[k]; });
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
    friendsDoc(me.uid).set({ list: list, updatedAt: nowMs() })
      .catch(function () { lastFriendsHash = ''; /* 次回リトライ */ });
  }
  function friendEntryByUid(uid) {
    var list = localFriends();
    for (var i = 0; i < list.length; i++) if (list[i].uid === uid) return list[i];
    return null;
  }
  function canCloudChat(uid) {
    if (!cloudActive()) return false;
    return !!friendEntryByUid(uid);
  }
  /* クラウド経路で送れる相手か（相手の公開プロフィールが実在する場合のみ
     クラウドへ書く。実在しない宛先への書き込みは成功扱いにせず、
     呼び出し側のフォールバック（PeerJS 直接送信）に任せる） */
  function userDocExists(uid) {
    if (!uid) return Promise.resolve(false);
    return userDoc(uid).get().then(function (d) { return !!d.exists; })
      .catch(function () { return false; });
  }

  /* プレゼンス購読（フレンドの公開プロフィールを見る） */
  var presenceUnsubs = {};   /* uid -> unsub */
  var presenceData = {};     /* uid -> {name, game, lastSeen, online} */
  function refreshPresenceWatch() {
    if (!cloudActive()) return;
    var list = localFriends();
    var wanted = {};
    list.forEach(function (f) { if (f.uid) wanted[f.uid] = true; });
    /* 不要になった購読を解除 */
    Object.keys(presenceUnsubs).forEach(function (uid) {
      if (!wanted[uid]) { try { presenceUnsubs[uid](); } catch (e) {} delete presenceUnsubs[uid]; delete presenceData[uid]; }
    });
    list.forEach(function (f) {
      if (!f.uid || presenceUnsubs[f.uid]) return;
      var uid = f.uid;
      presenceUnsubs[uid] = fb.db.doc('users/' + uid).onSnapshot(function (d) {
        if (!d.exists) return;
        var data = d.data() || {};
        presenceData[uid] = {
          name: data.username || '', game: data.currentGame || null,
          lastSeen: data.lastSeen || 0, online: !!data.online,
          iconId: data.iconId || '', iconColor: data.iconColor || '',
          comment: data.comment || '', stats: data.stats || null,
          mainChar: data.mainChar || ''
        };
        pushPresence(uid);
      }, function () {});
    });
  }
  function pushPresence(uid) {
    var api = pwf();
    if (!api || !api._cloud) return;
    var d = presenceData[uid];
    if (!d) return;
    var online = d.online && (nowMs() - (d.lastSeen || 0) < PRESENCE_STALE_MS);
    api._cloud.setPresence(uid, {
      online: online, name: d.name || '', game: d.game,
      lastSeen: d.lastSeen || 0, iconId: d.iconId || '', iconColor: d.iconColor || '',
      comment: d.comment || '', stats: d.stats || null, mainChar: d.mainChar || ''
    });
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
            from: inv.fromUid, name: inv.fromName || '', game: inv.game,
            room: inv.room, cloudId: d.id
          });
        }
        fb.db.doc('invites/' + d.id).set({ status: 'delivered' }, { merge: true }).catch(function () {});
      });
    }, function () {});
    unsubs.push(unsub);
  }
  function sendInviteCloud(opts) {
    if (!cloudActive() || !opts || !opts.toUid) return Promise.resolve(false);
    return userDocExists(opts.toUid).then(function (exists) {
      if (!exists) return false;
      return fb.db.collection('invites').add({
        toUid: opts.toUid,
        fromUid: me.uid, fromName: me.username,
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
      var bulk = {};   /* uid -> [{f,x,ts}] 既読分の一括取り込み */
      var live = [];   /* 新着（未読扱い） */
      msgs.forEach(function (m) {
        if (processedMsgIds[m._id]) return;
        processedMsgIds[m._id] = true;
        if ((m.ts || 0) <= (meta.chatResetAt || 0)) return; /* v50リセットで履歴を消した端末では、それ以前の履歴を取り込まない */
        var mine = m.from === me.uid;
        var peerUid = mine ? m.to : m.from;
        if (!peerUid) return;
        var seen = meta.chatSeen[peerUid] || 0;
        if ((m.ts || 0) <= seen) {
          (bulk[peerUid] || (bulk[peerUid] = [])).push({ f: mine ? 'me' : 'th', x: m.text || '', ts: m.ts || 0 });
        } else {
          live.push({ uid: peerUid, mine: mine, x: m.text || '', ts: m.ts || 0 });
          if ((m.ts || 0) > (meta.chatSeen[peerUid] || 0)) meta.chatSeen[peerUid] = m.ts || 0;
        }
      });
      var api = pwf();
      if (api && api._cloud) {
        Object.keys(bulk).forEach(function (uid) { api._cloud.mergeChats(uid, bulk[uid]); });
        live.forEach(function (m) {
          if (m.mine) api._cloud.mergeChats(m.uid, [{ f: 'me', x: m.x, ts: m.ts }]);
          else api._cloud.receiveChat(m.uid, { x: m.x, ts: m.ts });
        });
      }
      if (live.length) saveMetaNow();
    }, function () {});
    unsubs.push(unsub);
  }
  function sendChatCloud(uid, text) {
    if (!cloudActive() || !uid) return Promise.resolve(false);
    return userDocExists(uid).then(function (exists) {
      if (!exists) return false;
      var pair = [me.uid, uid].sort();
      return fb.db.collection('messages').add({
        participants: pair, from: me.uid, to: uid,
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
        return { uid: uid, username: data.username || v.name };
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
      var list = localFriends();
      for (var i = 0; i < list.length; i++) {
        if (list[i].uid === found.uid) {
          return { ok: false, msg: 'すでにフレンドに登録されています' };
        }
      }
      var entry = { uid: found.uid, username: found.username, addedAt: nowMs() };
      var api = pwf();
      if (api && api._cloud && api._cloud.addFriend) api._cloud.addFriend(entry);
      else { list.push(entry); try { localStorage.setItem('playweb_friends', JSON.stringify(list)); } catch (e) {} }
      refreshPresenceWatch();
      return { ok: true, msg: found.username + 'さんをフレンドに追加しました' };
    });
  }

  /* ---------------- プロフィール作成・プレゼンス ---------------- */
  function nameTakenError() {
    var err = new Error('username taken');
    err.code = 'pw/name-taken';
    return err;
  }
  /* ユーザー名の確保: 既に自分の uid で確保済みなら何もしない（再ログインや
     onAuthUser との競合でも失敗しない）。他人の uid なら pw/name-taken を投げる。 */
  function claimUsername(uid, lower) {
    var ref = fb.db.doc('usernames/' + lower);
    return ref.get().then(function (d) {
      if (d.exists) {
        if (d.data() && d.data().uid === uid) return;
        throw nameTakenError();
      }
      return ref.set({ uid: uid }).catch(function (e) {
        if (!e || e.code !== 'permission-denied') throw e;
        /* set が権限エラー: 競合で他者が先に作ったか、ルール未反映か再確認する */
        return ref.get().then(function (d2) {
          if (d2.exists && d2.data() && d2.data().uid === uid) return;
          if (d2.exists) throw nameTakenError();
          throw e;
        });
      });
    });
  }
  function ensureProfileDocs(uid, username) {
    var lower = username.toLowerCase();
    return Promise.all([
      userDoc(uid).set({
        username: username, usernameLower: lower,
        online: true, lastSeen: nowMs(), currentGame: MY_GAME
      }, { merge: true }),
      claimUsername(uid, lower)
    ]);
  }
  function heartbeat() {
    if (!cloudActive()) return;
    userDoc(me.uid).set({
      online: true, lastSeen: nowMs(), currentGame: MY_GAME,
      username: me.username, usernameLower: me.usernameLower
    }, { merge: true }).catch(function () {});
    refreshAllPresence();
  }
  function setOffline() {
    if (!me || !fb) return;
    try {
      userDoc(me.uid).set({ online: false, lastSeen: nowMs() }, { merge: true }).catch(function () {});
    } catch (e) {}
  }

  /* ---------------- プロフィールの保存と publish（v52〜） ---------------- */
  function isAdmin() {
    return !!(me && ADMIN_UIDS.indexOf(me.uid) >= 0);
  }
  /* プロフィール文書の拡張フィールドを myProfile へ取り込む */
  function absorbProfileData(data) {
    if (!data) return;
    if (typeof data.iconId === 'string') myProfile.iconId = data.iconId;
    if (typeof data.iconColor === 'string') myProfile.iconColor = data.iconColor;
    if (typeof data.comment === 'string') myProfile.comment = data.comment;
    if (data.stats && typeof data.stats === 'object') myProfile.stats = data.stats;
    if (typeof data.mainChar === 'string') myProfile.mainChar = data.mainChar;
  }
  /* アイコン/コメントの保存（本人のプロフィール文書へ merge 書き込み） */
  function setMyProfile(patch) {
    if (!me || !fb) return Promise.resolve({ ok: false, msg: 'ログインが必要です' });
    var next = {
      iconId: (patch && typeof patch.iconId === 'string') ? patch.iconId : myProfile.iconId,
      iconColor: (patch && typeof patch.iconColor === 'string') ? patch.iconColor : myProfile.iconColor,
      comment: (patch && typeof patch.comment === 'string') ? patch.comment : myProfile.comment
    };
    if (next.iconId && !PROFILE_ICON_MAP[next.iconId]) next.iconId = '';
    if (next.iconColor && !PROFILE_COLOR_MAP[next.iconColor]) next.iconColor = '';
    /* 一言コメント: 30文字まで。制御文字は除き、前後の空白を詰める */
    next.comment = String(next.comment || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 30);
    return userDoc(me.uid).set(next, { merge: true }).then(function () {
      myProfile.iconId = next.iconId;
      myProfile.iconColor = next.iconColor;
      myProfile.comment = next.comment;
      updateModal();
      return { ok: true, msg: 'プロフィールを保存しました' };
    }).catch(function () {
      return { ok: false, msg: '保存できませんでした（通信環境を確認してください）' };
    });
  }
  /* 戦績集計（stats）と使用キャラ（mainChar）を公開プロフィールへ publish する。
     内容が変わった時だけ書く（ログイン時＋記録/セーブ変更時に呼ばれる） */
  function publishProfileExtras() {
    if (!cloudActive()) return;
    var stats = computeMyStats();
    var mainChar = readMainChar();
    myProfile.stats = stats;
    myProfile.mainChar = mainChar;
    var json = JSON.stringify({ s: stats, m: mainChar });
    if (json === lastExtrasJson) return;
    lastExtrasJson = json;
    userDoc(me.uid).set({ stats: stats, mainChar: mainChar }, { merge: true })
      .catch(function () { lastExtrasJson = ''; /* 次回リトライ */ });
  }
  function schedulePublishExtras() {
    if (extrasTimer) clearTimeout(extrasTimer);
    extrasTimer = setTimeout(function () { extrasTimer = null; publishProfileExtras(); }, 2000);
  }

  /* ---------------- サービス開始・停止 ---------------- */
  function startServices() {
    if (!me || servicesOn) return;
    servicesOn = true;
    updatePill(); updateModal(); updateSearchRow();
    /* セーブ同期（クラウドの戦績が降りてくる場合がある）の後に集計を publish */
    syncSaves().then(function () { publishProfileExtras(); });
    startAdminInbox();
    /* フレンド一覧: クラウドとマージしてから購読 */
    friendsDoc(me.uid).get().then(function (d) {
      var cloudList = (d.exists && d.data() && Array.isArray(d.data().list)) ? d.data().list : [];
      if (meta.friendsResetPending) {
        /* v50 リセット直後: クラウドが移行より後に更新されていなければ、
           リセット後のローカル状態でクラウドを上書きする（マージで復活させない）。
           クラウドの方が新しければ（別端末で登録し直した等）通常マージに戻す。 */
        var cloudAt = (d.exists && d.data() && d.data().updatedAt) || 0;
        meta.friendsResetPending = false;
        saveMetaNow();
        if (cloudAt <= (meta.friendsResetAt || 0)) {
          var localNow = localFriends();
          applyFriendsToLocal(localNow);
          friendsDoc(me.uid).set({ list: localNow, updatedAt: nowMs() }).catch(function () {});
          refreshPresenceWatch();
          return;
        }
      }
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
    fbInboxItems = [];
    fbInboxDetailId = null;
    fbInboxStarted = false;
    profDraft = null;
    var pv = $('pwaProfileView');
    if (pv) { pv.style.display = 'none'; pv.innerHTML = ''; }
    updatePill(); updateModal(); updateSearchRow();
  }
  var lastPullAt = 0;
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      /* タブが隠れたら即オフライン化（フレンド側にすぐ伝わる） */
      if (cloudActive()) setOffline();
      return;
    }
    /* 戻ってきたら即ハートビートでオンライン復帰＋必要ならセーブ同期 */
    if (cloudActive()) heartbeat();
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
  /* 登録・ログインの最中は onAuthUser 側の自動遷移（再読み込み等）を抑え、
     こちらのハンドラが遷移（登録=移行つき再読み込み／ログイン=破棄つき再読み込み）を担当する */
  var authTransition = null;   /* null | 'signup' | 'login' */
  function doSignup(username, password) {
    var v = validateUsername(username);
    if (!v.ok) return Promise.resolve({ ok: false, msg: v.error });
    var pv = validatePassword(password);
    if (!pv.ok) return Promise.resolve({ ok: false, msg: pv.error });
    if (!fb) return Promise.resolve({ ok: false, msg: 'ログイン機能を読み込めませんでした' });
    var name = v.name;
    /* 注意: ルール上 usernames の get はログイン済みでないと許可されないため、
       登録前の空き確認はできない。まず認証ユーザーを作り、ログイン状態で
       名前を確保する（claimUsername）。他人が確保済みなら巻き戻す。 */
    pendingUsername = name;
    authTransition = 'signup';
    return fb.auth.createUserWithEmailAndPassword(usernameToEmail(name), password).then(function (cred) {
      var uid = cred.user.uid;
      return ensureProfileDocs(uid, name).then(function () {
        pendingUsername = null;
        /* authTransition は再読み込みまで保持する（解除すると、破棄される旧ページで
           onAuthUser がサービスを開始してしまい、移行処理や同期が中途半端になる） */
        /* ゲスト中に遊んだ分をディスク優先マージで移し、ヒントを立ててから
           再読み込みする（再読み込み後はシム無効で始まり、初回移行アップロードに繋がる） */
        flushGuestStoreDiskFirst();
        writeHint(true);
        setTimeout(function () { location.reload(); }, 500);
        return { ok: true, msg: 'アカウントを作成しました' };
      }).catch(function (e) {
        pendingUsername = null;
        authTransition = null;
        if (e && e.code === 'pw/name-taken') {
          /* ユーザー名が他人に使われていた: 作った認証ユーザーを消して巻き戻す */
          try { cred.user.delete().catch(function () {}); } catch (err) {}
          return { ok: false, msg: 'このユーザー名は既に使われています' };
        }
        /* それ以外の失敗（ルール未反映など）: 認証ユーザーは作れているので
           巻き戻さない。次回ログイン時に ensureProfileDocs が再試行する */
        return { ok: false, msg: authErrorMessage(e) };
      });
    }).catch(function (e) {
      pendingUsername = null;
      authTransition = null;
      return { ok: false, msg: authErrorMessage(e) };
    });
  }
  function doLogin(username, password) {
    var v = validateUsername(username);
    if (!v.ok) return Promise.resolve({ ok: false, msg: v.error });
    if (!fb) return Promise.resolve({ ok: false, msg: 'ログイン機能を読み込めませんでした' });
    authTransition = 'login';
    return fb.auth.signInWithEmailAndPassword(usernameToEmail(v.name), password)
      .then(function () {
        /* authTransition は再読み込みまで保持する（doSignup と同じ理由） */
        /* ゲスト中に遊んだ分は破棄する（クラウド/ディスクのセーブで再開し、
           ゲスト分でクラウドを上書きしない）。ヒントを立てて再読み込み。 */
        memStore = {};
        guestActive = false;
        writeHint(true);
        setTimeout(function () { location.reload(); }, 500);
        return { ok: true, msg: 'ログインしました' };
      })
      .catch(function (e) {
        authTransition = null;
        return { ok: false, msg: authErrorMessage(e) };
      });
  }
  function doLogout() {
    if (!fb) return Promise.resolve();
    setOffline();
    stopServices();
    me = null;
    /* サインアウト完了を待たずにゲスト化する（onAuthUser(null) の自動遷移と競合させない）。
       以後の保存はメモリ内のみになり、ディスクのセーブは次回ログインまで見えなくなる */
    guestActive = true;
    memStore = {};
    return fb.auth.signOut().catch(function () {}).then(function () {
      writeHint(false);
      setGate('guest');
      updatePill(); updateModal(); updateSearchRow();
    });
  }
  function onAuthUser(user) {
    if (!user) {
      writeHint(false);
      if (me) { stopServices(); me = null; }
      if (!authTransition && !guestActive) {
        /* ログイン見込み（ヒントあり）で読み込んだのにセッションが無い/消えた:
           ゲスト状態へ倒す。再読み込みでシムを効かせる（1回だけ。無理ならその場で有効化） */
        if (!reloadOnce('l2g')) { guestActive = true; memStore = {}; }
        else return; /* 再読み込み中 */
      }
      if (guestActive) clearReloadGuard();
      setGate(sdkState === 'unavailable' ? 'sdk-down' : 'guest');
      updatePill(); updateModal(); updateSearchRow();
      return;
    }
    /* 陳腐化した認証イベントのガード: 名前確保に失敗して認証ユーザーを
       巻き戻した直後など、既にサインアウト済みのユーザーに対する遅延イベントが
       届くことがある。現在のセッションが無いならそのイベントは無視する
       （ゲスト扱いのままにして、誤った再読み込みを防ぐ） */
    if (fb && fb.auth && !fb.auth.currentUser) return;
    writeHint(true);
    if (authTransition) {
      /* 登録・ログインのハンドラが遷移（再読み込み）を担当する。ここではサービスを
         開始しない（破棄される旧ページで同期や移行処理が中途半端に走るのを防ぐ）。
         doLogin/doSignup が先に guestActive を解除していても、こちらを優先する */
      var tname = pendingUsername || (user.email || '').split('@')[0] || 'player';
      me = { uid: user.uid, username: tname, usernameLower: tname.toLowerCase() };
      setGate('member');
      updatePill(); updateModal(); updateSearchRow();
      return;
    }
    if (guestActive) {
      /* 別タブでのログイン等でセッションが現れた: ゲスト分は破棄して読み込み直す */
      if (!reloadOnce('g2l')) { guestActive = false; memStore = {}; }
      else return; /* 再読み込み中 */
    }
    clearReloadGuard();
    var uid = user.uid;
    userDoc(uid).get().then(function (d) {
      absorbProfileData(d.exists ? d.data() : null);
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
      setGate('member');
      /* 公開プロフィール（ユーザー名・在席）を最新化してからサービス開始 */
      ensureProfileDocs(uid, username).catch(function () {}).then(function () {
        startServices();
      });
    }).catch(function () {
      /* プロフィール取得に失敗しても最低限ログイン状態にはする */
      var name = pendingUsername || (user.email || '').split('@')[0] || 'player';
      pendingUsername = null;
      me = { uid: uid, username: name, usernameLower: name.toLowerCase() };
      setGate('member');
      startServices();
    });
  }

  /* ---------------- UI（共通ヘッダー＋アカウントドロワー） ----------------
     v51〜 全ページ共通。ヘッダーは通常フロー先頭の sticky バー（46px）で、
     ゲーム側のレイアウトには「ヘッダー分の高さ」だけが増える。100dvh 系の
     ゲームは flex 縦並び等の既存構造で吸収する（個別調整は各ゲーム側）。
     ドロワーは右からスライドインする半透明パネルで、開いても裏のゲームは
     壊れない（入力だけスクリムで遮断する）。 */
  var HEADER_H = 46;
  var GAME_TITLES = {
    portal: 'PlayWeb', tetris: 'テトリス', suica: 'スイカゲーム', crepe: 'クレープ工房',
    survivors: 'まじょねこサバイバーズ', frostline: 'フロストライン', blockblast: 'ブロックブラスト',
    minesweeper: 'マインスイーパ', reversi: 'オセロ', shogi: '将棋', majan: '麻雀',
    daihugou: '大富豪', hanahuda: '花札', uno: 'UNO', blockzushi: 'ブロック崩し',
    jump: 'ジャンプラン', caring: '育成ゲーム', gamedev: 'ゲーム工房物語',
    rpg: 'モンスターライズ', otome: '乙女ゲーム', linksaga: 'スターリンクサーガ'
  };
  function pageTitle() {
    if (typeof window.PW_PAGE_TITLE === 'string' && window.PW_PAGE_TITLE) return window.PW_PAGE_TITLE;
    return GAME_TITLES[MY_GAME] || MY_GAME;
  }
  var CSS = [
    ':root{--pw-header-h:' + HEADER_H + 'px}',
    '#pwHeader{position:sticky;top:0;z-index:99995;height:' + HEADER_H + 'px;flex:0 0 auto;display:flex;align-items:center;gap:9px;padding:0 10px;background:rgba(10,12,26,.93);backdrop-filter:blur(8px);border-bottom:1px solid rgba(255,255,255,.13);color:#eef0ff;font-family:"Hiragino Kaku Gothic ProN","Noto Sans JP",system-ui,sans-serif;box-sizing:border-box;width:100%;max-width:none;flex-wrap:nowrap;margin:0}',
    '#pwHeader *{box-sizing:border-box}',
    '.pw-home{flex:0 0 auto;display:flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:10px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.16);color:#fff;text-decoration:none;font-size:17px;line-height:1}',
    '.pw-home:active{transform:translateY(1px)}',
    '.pw-gtitle{font-size:14.5px;font-weight:900;letter-spacing:.03em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}',
    '.pw-tabs{margin-left:auto;flex:0 0 auto;display:flex;gap:6px}',
    '.pw-tab{position:relative;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.15);color:#c6cbe8;border-radius:999px;padding:7px 14px;font-size:13px;font-weight:800;cursor:pointer;font-family:inherit}',
    '.pw-tab.on{background:linear-gradient(90deg,#0891b2,#7c3aed);color:#fff;border-color:transparent}',
    '.pw-tab .pw-dot{position:absolute;top:5px;right:6px;width:8px;height:8px;border-radius:50%;background:#8a90ad;border:1.5px solid #0d1020;pointer-events:none}',
    '.pw-tab.on .pw-dot{background:#3ED6A5}',
    '#pwTabBadge{position:absolute;top:-6px;right:-6px;min-width:19px;height:19px;border-radius:999px;background:#ef4444;color:#fff;font-size:11px;font-weight:900;padding:0 5px;display:none;align-items:center;justify-content:center;border:2px solid #0b1026;pointer-events:none}',
    '#pwDrawerWrap{position:fixed;inset:0;z-index:100006;pointer-events:none;font-family:"Hiragino Kaku Gothic ProN","Noto Sans JP",system-ui,sans-serif}',
    /* スクリムとドロワーは共通ヘッダーの下から始める（開いている間も
       ヘッダーのタブでメインへ戻れるようにするため） */
    '#pwDrawerScrim{position:absolute;left:0;right:0;bottom:0;top:var(--pw-header-h,46px);background:rgba(3,4,12,.48);opacity:0;transition:opacity .3s ease;pointer-events:none}',
    '#pwDrawer{position:absolute;top:var(--pw-header-h,46px);right:0;bottom:0;width:min(400px,88vw);background:rgba(13,16,32,.9);backdrop-filter:blur(12px);border-left:1px solid rgba(255,255,255,.13);box-shadow:-18px 0 44px rgba(0,0,0,.5);color:#eef0ff;padding:16px 16px 30px;overflow-y:auto;transform:translateX(106%);transition:transform .32s cubic-bezier(.32,.72,.24,1);-webkit-overflow-scrolling:touch;pointer-events:none}',
    /* ラッパー自体は常にクリックを素通しし、スクリムとドロワーだけが受ける
       （ヘッダーのタブを開いたまま操作できるように） */
    '#pwDrawerWrap.open #pwDrawerScrim{opacity:1;pointer-events:auto}',
    '#pwDrawerWrap.open #pwDrawer{transform:translateX(0);pointer-events:auto}',
    '.pw-drawer-head{display:flex;align-items:center;justify-content:space-between;font-size:16.5px;font-weight:900;margin-bottom:10px}',
    '.pw-drawer-sec{font-size:12px;font-weight:900;letter-spacing:.14em;color:#9aa1c0;margin:20px 0 8px}',
    '.pw-x{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);color:#eef0ff;width:32px;height:32px;border-radius:50%;font-size:14px;cursor:pointer;flex:0 0 auto}',
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
    /* v52: プロフィール（アバター/戦績/アイコン選択） */
    '.pwa-ava{display:inline-flex;align-items:center;justify-content:center;border-radius:50%;color:#fff;flex:0 0 auto;vertical-align:middle;box-shadow:inset 0 0 0 2px rgba(255,255,255,.25)}',
    '.pwa-prof{display:flex;gap:12px;align-items:center;margin:8px 0 4px}',
    '.pwa-prof-meta{min-width:0;flex:1}',
    '.pwa-prof-comment{font-size:13px;color:#d6d9ec;line-height:1.55;word-break:break-word;margin-top:6px}',
    '.pwa-stats{margin-top:2px}',
    '.pwa-stat-row{display:flex;justify-content:space-between;gap:10px;font-size:12.5px;color:#c6cbe8;padding:2.5px 0}',
    '.pwa-stat-row b{color:#eef0ff;font-weight:800;white-space:nowrap}',
    '.pwa-stat-row span{text-align:right}',
    '.pwa-icon-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:7px;margin:4px 0 2px}',
    '.pwa-icon-cell{background:rgba(255,255,255,.05);border:2px solid transparent;border-radius:12px;padding:5px 0;display:flex;align-items:center;justify-content:center;cursor:pointer}',
    '.pwa-icon-cell.on{border-color:#22d3ee;background:rgba(34,211,238,.12)}',
    '.pwa-color-row{display:flex;gap:8px;margin:4px 0 6px;flex-wrap:wrap}',
    '.pwa-color-cell{width:30px;height:30px;border-radius:50%;border:2px solid transparent;cursor:pointer;padding:0}',
    '.pwa-color-cell.on{border-color:#fff;box-shadow:0 0 0 2px rgba(34,211,238,.7)}',
    /* v52: フィードバック（フォーム/意見ボックス） */
    '#pwFbWrap{position:fixed;inset:0;z-index:100050;display:none;align-items:flex-start;justify-content:center;background:rgba(3,4,12,.62);backdrop-filter:blur(3px);font-family:"Hiragino Kaku Gothic ProN","Noto Sans JP",system-ui,sans-serif;padding:5vh 14px 14px;box-sizing:border-box}',
    '#pwFbWrap.open{display:flex}',
    '#pwFbWrap *{box-sizing:border-box}',
    '.pw-fb-card{background:#12162c;border:1px solid rgba(255,255,255,.14);border-radius:18px;color:#eef0ff;width:min(480px,100%);max-height:88vh;overflow-y:auto;padding:18px;box-shadow:0 24px 60px rgba(0,0,0,.55)}',
    '.pw-fb-card h3{font-size:16.5px;font-weight:900;margin-bottom:4px}',
    '.pw-fb-card label{display:block;font-size:12px;font-weight:800;color:#9aa1c0;margin:12px 0 5px}',
    '.pw-fb-card textarea.pwa-input{resize:vertical;min-height:110px}',
    '.pw-fb-item{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:10px 12px;margin-bottom:8px;cursor:pointer}',
    '.pw-fb-item .t{font-weight:800;font-size:13.5px;color:#eef0ff;word-break:break-word}',
    '.pw-fb-item .m{font-size:11.5px;color:#9aa1c0;margin-top:2px;line-height:1.5}',
    '.pw-fb-badge{display:inline-block;font-size:10px;font-weight:900;border-radius:999px;padding:1px 7px;margin-right:6px;vertical-align:1px}',
    '.pw-fb-badge.new{background:#ef4444;color:#fff}',
    '.pw-fb-badge.read{background:rgba(255,255,255,.14);color:#9aa1c0}',
    '.pw-fb-badge.type{background:rgba(34,211,238,.18);color:#67e8f9}',
    '.pw-fb-body{white-space:pre-wrap;word-break:break-word;font-size:13.5px;line-height:1.7;color:#e6e9f7;background:rgba(255,255,255,.04);border-radius:12px;padding:12px;margin-top:8px}'
  ].join('\n');
  var headerEl = null, drawerWrapEl = null, drawerOpen = false;
  function buildUI() {
    if (headerEl) return;
    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    headerEl = document.createElement('header');
    headerEl.id = 'pwHeader';
    headerEl.innerHTML =
      '<a class="pw-home" href="index.html" aria-label="ホーム（ポータル）へ戻る">🏠</a>' +
      '<span class="pw-gtitle">' + esc(pageTitle()) + '</span>' +
      '<nav class="pw-tabs">' +
      '<button class="pw-tab on" id="pwTabMain">メイン</button>' +
      '<button class="pw-tab" id="pwTabAccount">アカウント<span class="pw-dot"></span><span id="pwTabBadge"></span></button>' +
      '</nav>';
    if (document.body.firstChild) document.body.insertBefore(headerEl, document.body.firstChild);
    else document.body.appendChild(headerEl);
    headerEl.querySelector('#pwTabMain').onclick = function () { closeModal(); };
    headerEl.querySelector('#pwTabAccount').onclick = function () { openModal(); };

    drawerWrapEl = document.createElement('div');
    drawerWrapEl.id = 'pwDrawerWrap';
    drawerWrapEl.innerHTML =
      '<div id="pwDrawerScrim"></div>' +
      '<aside id="pwDrawer" aria-label="アカウント">' +
      '<div class="pw-drawer-head"><span>👤 アカウント</span>' +
      '<button class="pw-x" id="pwDrawerClose" aria-label="閉じる">✕</button></div>' +
      '<div id="pwaBody"></div>' +
      '<div id="pwaProfileView" style="display:none"></div>' +
      '<div id="pwFriendsSec" data-pw-member-only style="display:none">' +
      '<div class="pw-drawer-sec">👥 フレンド</div>' +
      '<div id="pwFriendsMount"></div>' +
      '</div>' +
      '<div class="pwa-note" data-pw-guest-note style="display:none;margin-top:16px">いまはゲストとして遊んでいます。ゲストでは1人用モードのみで、セーブデータは保存されません。ログインすると、マルチプレイ・フレンド・セーブ（クラウド同期）が使えるようになります。</div>' +
      '<div id="pwFbAdminSec" style="display:none">' +
      '<div class="pw-drawer-sec">📮 意見ボックス（管理者用）</div>' +
      '<div id="pwFbInbox"><div class="pwa-note">読み込み中…</div></div>' +
      '</div>' +
      '</aside>';
    document.body.appendChild(drawerWrapEl);
    drawerWrapEl.querySelector('#pwDrawerScrim').addEventListener('click', closeModal);
    drawerWrapEl.querySelector('#pwDrawerClose').onclick = closeModal;
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && drawerOpen) closeModal(); });
    updatePill(); updateModal();
    applyMemberOnlyVisibility();
  }
  /* ヘッダーのアカウントタブ表示（ログイン状態ドット）を最新化する。
     旧ピルの updatePill と同じ呼び出し箇所から使う */
  function updatePill() {
    if (!headerEl) return;
    var tab = headerEl.querySelector('#pwTabAccount');
    if (tab) {
      tab.classList.toggle('on', drawerOpen);
      var dot = tab.querySelector('.pw-dot');
      if (dot) dot.style.background = me ? '#3ED6A5' : '';
      tab.title = me ? (me.username + '（ログイン中）') : 'ログイン / 新規登録';
    }
    var main = headerEl.querySelector('#pwTabMain');
    if (main) main.classList.toggle('on', !drawerOpen);
    refreshAdminUI();
  }
  function notifyFriendsView() {
    var api = window.PWFriends;
    if (api && api._viewState) { try { api._viewState(drawerOpen); } catch (e) {} }
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
      body.innerHTML = '<div class="pwa-note err">ログイン機能を読み込めませんでした（通信環境を確認してください）。この環境ではゲスト扱いとなり、1人用モードのみ遊べます（マルチプレイ・フレンド・セーブ保存は使えません）。既存のセーブデータが消えることはありません。</div>';
      return;
    }
    if (me) {
      var myStats = myProfile.stats || computeMyStats();
      var myChar = myProfile.mainChar || readMainChar();
      body.innerHTML =
        '<div class="pwa-prof">' + profileIconHTML(myProfile, 46) +
        '<div class="pwa-prof-meta"><div class="pwa-note" style="margin:0">ログイン中</div>' +
        '<div class="pwa-user" style="margin:0">' + esc(me.username) + '</div>' +
        (myProfile.comment ? '<div class="pwa-prof-comment" style="margin-top:2px">' + esc(myProfile.comment) + '</div>' : '') +
        '</div></div>' +
        (myChar ? '<div class="pwa-note">🎴 使用キャラ（スターリンクサーガ）: <b style="color:#fde68a">' + esc(myChar) + '</b></div>' : '') +
        '<button class="pwa-btn sub" id="pwaProfEditBtn" style="margin-top:8px">✏️ プロフィールを編集</button>' +
        '<div id="pwaProfEditor"></div>' +
        '<div class="pw-drawer-sec">🎮 ゲーム別戦績</div>' + statsHTML(myStats) +
        '<div class="pwa-note" id="pwaStatus">' + esc(statusText || 'クラウドセーブ有効') + '</div>' +
        '<div class="pwa-note">セーブデータ・フレンド・戦績はクラウドに同期されます。別の端末で同じアカウントにログインすると続きが遊べます。</div>' +
        '<button class="pwa-btn sub" id="pwaFeedbackBtn" style="margin-top:12px">📮 お問い合わせ・要望・バグ報告</button>' +
        '<button class="pwa-btn sub" id="pwaLogout" style="margin-top:8px">ログアウト</button>' +
        '<div class="pwa-note">ログアウトするとゲストに戻ります。セーブデータは消えませんが、ログインするまで表示・保存されません。</div>';
      $('pwaLogout').onclick = function () { doLogout(); };
      $('pwaFeedbackBtn').onclick = function () { openFeedback(); };
      $('pwaProfEditBtn').onclick = function () { toggleProfEditor(); };
      refreshAdminUI();
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
      '<button class="pwa-btn sub" id="pwaFeedbackBtn" style="margin-top:4px">📮 お問い合わせ・要望・バグ報告（ゲストでも送れます）</button>' +
      '<div class="pwa-note">いまはゲストとして遊んでいます。ゲストでは1人用モードのみで、セーブデータは保存されません。ログインすると、マルチプレイ・フレンド・セーブ（クラウド同期）が使えるようになり、別の端末でも続きが遊べます。</div>';
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
    $('pwaFeedbackBtn').onclick = function () { openFeedback(); };
    $('pwaPass').addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
  }
  /* アカウントドロワーの開閉（旧モーダルの openModal/closeModal を置き換え。
     friends.js の loginNotice など既存の呼び出しはそのままドロワーを開く） */
  function openModal() {
    buildUI();
    if (!drawerWrapEl) return;
    drawerOpen = true;
    drawerWrapEl.classList.add('open');
    updatePill(); updateModal();
    notifyFriendsView();
  }
  function closeModal() {
    if (!drawerWrapEl) { drawerOpen = false; return; }
    drawerOpen = false;
    drawerWrapEl.classList.remove('open');
    updatePill();
    notifyFriendsView();
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

  /* ---------------- プロフィール表示（v52〜） ---------------- */
  function statsHTML(stats) {
    if (!stats || !Object.keys(stats).length) {
      return '<div class="pwa-note">まだ戦績がありません。フレンドと対戦・協力すると、ここにゲーム別の成績が表示されます。</div>';
    }
    var rows = Object.keys(stats).map(function (g) {
      var s = stats[g] || {};
      var parts = [];
      if (s.w || s.l || s.d) parts.push((s.w || 0) + '勝' + (s.l || 0) + '敗' + (s.d ? s.d + '分' : ''));
      if (s.p) parts.push('プレイ' + s.p + '回');
      if (s.c) parts.push('クリア' + s.c + '回');
      return '<div class="pwa-stat-row"><b>' + esc(GAME_TITLES[g] || g) + '</b><span>' + esc(parts.join('・')) + '</span></div>';
    }).join('');
    return '<div class="pwa-stats">' + rows + '</div>';
  }
  /* プロフィール編集（アイコン/背景色/一言コメント） */
  var profDraft = null;
  function toggleProfEditor() {
    var box = $('pwaProfEditor');
    if (!box) return;
    if (profDraft) { profDraft = null; box.innerHTML = ''; return; }
    profDraft = { iconId: myProfile.iconId, iconColor: myProfile.iconColor };
    renderProfEditor();
  }
  function renderProfEditor() {
    var box = $('pwaProfEditor');
    if (!box || !profDraft) return;
    var colId = profDraft.iconColor || 'violet';
    var cell = function (iconId) {
      var p = { iconId: iconId, iconColor: colId, name: me ? me.username : '' };
      return '<button class="pwa-icon-cell' + (profDraft.iconId === iconId ? ' on' : '') + '" data-icon="' + iconId + '">' + profileIconHTML(p, 30) + '</button>';
    };
    var cells = PROFILE_ICONS.map(function (ic) { return cell(ic.id); }).join('');
    var colors = PROFILE_COLORS.map(function (c) {
      return '<button class="pwa-color-cell' + (profDraft.iconColor === c.id ? ' on' : '') + '" data-color="' + c.id + '" style="background:' + c.c + '" aria-label="背景色 ' + c.id + '"></button>';
    }).join('');
    box.innerHTML =
      '<div class="pw-drawer-sec">アイコン（左端は頭文字）</div><div class="pwa-icon-grid">' + cell('') + cells + '</div>' +
      '<div class="pw-drawer-sec">背景色</div><div class="pwa-color-row">' + colors + '</div>' +
      '<div class="pw-drawer-sec">一言コメント（30文字まで）</div>' +
      '<input class="pwa-input" id="pwaProfComment" maxlength="30" placeholder="例：オセロ強くなりたい" value="' + esc(myProfile.comment) + '">' +
      '<button class="pwa-btn" id="pwaProfSave">保存する</button>' +
      '<div class="pwa-note" id="pwaProfMsg"></div>';
    box.querySelectorAll('[data-icon]').forEach(function (b) {
      b.onclick = function () { profDraft.iconId = b.getAttribute('data-icon'); renderProfEditor(); };
    });
    box.querySelectorAll('[data-color]').forEach(function (b) {
      b.onclick = function () { profDraft.iconColor = b.getAttribute('data-color'); renderProfEditor(); };
    });
    $('pwaProfSave').onclick = function () {
      var btn = $('pwaProfSave');
      btn.disabled = true;
      setMyProfile({
        iconId: profDraft.iconId, iconColor: profDraft.iconColor,
        comment: $('pwaProfComment').value
      }).then(function (r) {
        if (r.ok) { profDraft = null; /* setMyProfile 内で updateModal 済み */ }
        else {
          var m = $('pwaProfMsg');
          if (m) { m.textContent = r.msg; m.classList.add('err'); }
          btn.disabled = false;
        }
      });
    };
  }
  /* フレンド（または自分）のプロフィール画面をドロワー内に出す */
  function openProfile(uid) {
    buildUI();
    var view = $('pwaProfileView');
    if (!view) return;
    openModal();
    view.style.display = '';
    if (me && uid === me.uid) {
      renderProfileView(view, {
        name: me.username, iconId: myProfile.iconId, iconColor: myProfile.iconColor,
        comment: myProfile.comment, online: true, lastSeen: nowMs(), game: MY_GAME,
        stats: myProfile.stats || computeMyStats(), mainChar: myProfile.mainChar || readMainChar()
      });
      return;
    }
    var d = presenceData[uid];
    if (d) {
      renderProfileView(view, {
        name: d.name || (friendEntryByUid(uid) || {}).username || 'フレンド',
        iconId: d.iconId, iconColor: d.iconColor, comment: d.comment,
        online: d.online, lastSeen: d.lastSeen, game: d.game,
        stats: d.stats, mainChar: d.mainChar
      });
      return;
    }
    view.innerHTML = '<button class="pwa-btn sub" id="pwaProfBack" style="margin:14px 0 10px">← もどる</button><div class="pwa-note">読み込み中…</div>';
    bindProfBack(view);
    if (!fb) { view.innerHTML = '<button class="pwa-btn sub" id="pwaProfBack" style="margin:14px 0 10px">← もどる</button><div class="pwa-note">プロフィールを読み込めませんでした</div>'; bindProfBack(view); return; }
    userDoc(uid).get().then(function (doc) {
      if (!doc.exists) {
        view.innerHTML = '<button class="pwa-btn sub" id="pwaProfBack" style="margin:14px 0 10px">← もどる</button><div class="pwa-note">プロフィールが見つかりませんでした</div>';
        bindProfBack(view);
        return;
      }
      var data = doc.data() || {};
      renderProfileView(view, {
        name: data.username || 'フレンド', iconId: data.iconId || '', iconColor: data.iconColor || '',
        comment: data.comment || '', online: !!data.online, lastSeen: data.lastSeen || 0,
        game: data.currentGame || null, stats: data.stats || null, mainChar: data.mainChar || ''
      });
    }).catch(function () {
      view.innerHTML = '<button class="pwa-btn sub" id="pwaProfBack" style="margin:14px 0 10px">← もどる</button><div class="pwa-note">プロフィールを読み込めませんでした</div>';
      bindProfBack(view);
    });
  }
  function bindProfBack(view) {
    var b = view.querySelector('#pwaProfBack');
    if (b) b.onclick = function () { view.style.display = 'none'; view.innerHTML = ''; };
  }
  function renderProfileView(view, p) {
    var playing = p.online && p.game && GAME_TITLES[p.game] && (p.lastSeen && nowMs() - p.lastSeen < PRESENCE_STALE_MS);
    view.innerHTML =
      '<button class="pwa-btn sub" id="pwaProfBack" style="margin:14px 0 10px">← もどる</button>' +
      '<div class="pwa-prof">' + profileIconHTML(p, 56) +
      '<div class="pwa-prof-meta"><div class="pwa-user" style="margin:0">' + esc(p.name || 'プレイヤー') + '</div>' +
      '<div class="pwa-note" style="margin:2px 0 0">' + esc(relLastSeenText(p)) + (playing ? '・' + esc(GAME_TITLES[p.game]) + 'でプレイ中' : '') + '</div></div></div>' +
      (p.comment ? '<div class="pwa-prof-comment">💬 ' + esc(p.comment) + '</div>' : '') +
      (p.mainChar ? '<div class="pwa-note">🎴 使用キャラ（スターリンクサーガ）: <b style="color:#fde68a">' + esc(p.mainChar) + '</b></div>' : '') +
      '<div class="pw-drawer-sec">🎮 ゲーム別戦績</div>' + statsHTML(p.stats);
    bindProfBack(view);
  }

  /* ---------------- フィードバック（v52〜・作業4） ----------------
     フォームはポータルとドロワーから開けるモーダル。送信は Firestore の
     feedback コレクションへ add するだけ。ゲストでも送れる（ログインできない
     不具合の報告経路を塞がないため、フレンド系ゲートとは独立）。
     ※本番ルールに feedback の許可が入るまでは、本番環境では送信が
       ルールで拒否される（firestore.rules への追記はユーザーの再貼り付け待ち）。 */
  var FB_TYPE_LABELS = { contact: 'お問い合わせ', request: '要望', bug: 'バグ報告' };
  var fbWrapEl = null;
  function buildFeedback() {
    if (fbWrapEl) return;
    fbWrapEl = document.createElement('div');
    fbWrapEl.id = 'pwFbWrap';
    var gameOpts = '<option value="">（ゲーム共通・その他）</option>' + Object.keys(GAME_TITLES).filter(function (g) { return g !== 'portal'; }).map(function (g) {
      return '<option value="' + g + '">' + esc(GAME_TITLES[g]) + '</option>';
    }).join('');
    fbWrapEl.innerHTML =
      '<div class="pw-fb-card">' +
      '<h3>📮 お問い合わせ・要望・バグ報告</h3>' +
      '<div class="pwa-note" style="margin:0">運営へのメッセージを送れます。バグ報告は「どのゲームで・何をしたら・どうなったか」を書いてもらえると助かります。</div>' +
      '<label>種別</label><select class="pwa-input" id="pwFbType"><option value="contact">お問い合わせ</option><option value="request">要望</option><option value="bug">バグ報告</option></select>' +
      '<label>対象ゲーム（任意）</label><select class="pwa-input" id="pwFbGame">' + gameOpts + '</select>' +
      '<label>タイトル（必須・100文字まで）</label><input class="pwa-input" id="pwFbTitle" maxlength="100" placeholder="例：オセロで対戦が切断されました">' +
      '<label>本文（必須・2000文字まで）</label><textarea class="pwa-input" id="pwFbBody" maxlength="2000" placeholder="詳しい内容を書いてください"></textarea>' +
      '<div id="pwFbNameRow"><label>お名前（任意）</label><input class="pwa-input" id="pwFbName" maxlength="30" placeholder="名乗らなくても送れます"></div>' +
      '<button class="pwa-btn" id="pwFbSubmit">送信する</button>' +
      '<button class="pwa-btn sub" id="pwFbCancel" style="margin-top:8px">キャンセル</button>' +
      '<div class="pwa-note" id="pwFbMsg"></div></div>';
    document.body.appendChild(fbWrapEl);
    fbWrapEl.addEventListener('click', function (e) { if (e.target === fbWrapEl) closeFeedback(); });
    $('pwFbCancel').onclick = closeFeedback;
    $('pwFbSubmit').onclick = submitFeedbackFromUI;
  }
  function openFeedback() {
    buildUI();
    buildFeedback();
    if (!fbWrapEl) return;
    var row = $('pwFbNameRow');
    if (row) row.style.display = me ? 'none' : '';
    fbWrapEl.classList.add('open');
  }
  function closeFeedback() { if (fbWrapEl) fbWrapEl.classList.remove('open'); }
  function submitFeedback(data) {
    if (!fb) return Promise.resolve({ ok: false, msg: '送信できませんでした（通信環境を確認してください）' });
    return fb.db.collection('feedback').add({
      type: FB_TYPE_LABELS[data.type] ? data.type : 'contact',
      title: String(data.title || '').slice(0, 100),
      body: String(data.body || '').slice(0, 2000),
      game: data.game || '',
      fromUid: me ? me.uid : '',
      fromName: String(data.fromName || '').slice(0, 30),
      createdAt: nowMs(),
      status: 'new'
    }).then(function () { return { ok: true }; })
      .catch(function (e) { return { ok: false, msg: '送信できませんでした' + (e && e.code ? '（' + e.code + '）' : '') }; });
  }
  function submitFeedbackFromUI() {
    var title = $('pwFbTitle').value.trim();
    var body = $('pwFbBody').value.trim();
    var msg = $('pwFbMsg');
    msg.className = 'pwa-note';
    if (!title) { msg.textContent = 'タイトルを入力してください'; msg.classList.add('err'); return; }
    if (!body) { msg.textContent = '本文を入力してください'; msg.classList.add('err'); return; }
    var btn = $('pwFbSubmit');
    btn.disabled = true;
    msg.textContent = '送信中…';
    submitFeedback({
      type: $('pwFbType').value, game: $('pwFbGame').value, title: title, body: body,
      fromName: me ? me.username : $('pwFbName').value.trim()
    }).then(function (r) {
      btn.disabled = false;
      if (r.ok) {
        msg.textContent = '送信しました。ありがとうございます！';
        msg.classList.add('ok');
        $('pwFbTitle').value = '';
        $('pwFbBody').value = '';
        var api = pwf();
        if (api && api._cloud && api._cloud.toast) api._cloud.toast('📮 送信しました', 'info');
        setTimeout(closeFeedback, 900);
      } else {
        msg.textContent = r.msg;
        msg.classList.add('err');
      }
    });
  }

  /* ---------------- 意見ボックス（管理者用インボックス・v52〜） ----------------
     ADMIN_UIDS に自分の uid が入っている時だけドロワーに表示される。
     feedback を購読し、新着順に一覧表示。開いたら既読化できる。 */
  var fbInboxItems = [];
  var fbInboxDetailId = null;
  var fbInboxStarted = false;
  function refreshAdminUI() {
    var sec = $('pwFbAdminSec');
    if (sec) sec.style.display = isAdmin() ? '' : 'none';
  }
  function fmtDateTime(ts) {
    var d = new Date(ts || 0);
    return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate() + ' ' +
      ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }
  function startAdminInbox() {
    refreshAdminUI();
    if (!isAdmin() || !fb || fbInboxStarted) return;
    fbInboxStarted = true;
    var apply = function (snap) {
      var items = [];
      snap.forEach(function (d) {
        var x = d.data() || {};
        x._id = d.id;
        items.push(x);
      });
      items.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
      fbInboxItems = items.slice(0, 50);
      renderAdminInbox();
    };
    try {
      var unsub = fb.db.collection('feedback').onSnapshot(apply, function () {
        fb.db.collection('feedback').get().then(apply).catch(function () { renderAdminInboxError(); });
      });
      unsubs.push(unsub);
    } catch (e) {
      fb.db.collection('feedback').get().then(apply).catch(function () { renderAdminInboxError(); });
    }
  }
  function renderAdminInboxError() {
    var box = $('pwFbInbox');
    if (box) box.innerHTML = '<div class="pwa-note err">意見ボックスを読み込めませんでした（ルール未反映の可能性があります）</div>';
  }
  function renderAdminInbox() {
    var box = $('pwFbInbox');
    if (!box || !isAdmin()) return;
    if (fbInboxDetailId) {
      var cur = null;
      fbInboxItems.forEach(function (x) { if (x._id === fbInboxDetailId) cur = x; });
      if (cur) { renderAdminInboxDetail(box, cur); return; }
      fbInboxDetailId = null;
    }
    if (!fbInboxItems.length) {
      box.innerHTML = '<div class="pwa-note">まだ届いていません。</div>';
      return;
    }
    box.innerHTML = fbInboxItems.map(function (x) {
      return '<div class="pw-fb-item" data-fb-id="' + esc(x._id) + '">' +
        '<span class="pw-fb-badge type">' + esc(FB_TYPE_LABELS[x.type] || 'お問い合わせ') + '</span>' +
        '<span class="pw-fb-badge ' + (x.status === 'read' ? 'read' : 'new') + '">' + (x.status === 'read' ? '既読' : '新着') + '</span>' +
        '<span class="t">' + esc(x.title || '（無題）') + '</span>' +
        '<div class="m">' + esc(x.fromName || '名無し') + ' ・ ' + esc(fmtDateTime(x.createdAt)) +
        (x.game ? ' ・ ' + esc(GAME_TITLES[x.game] || x.game) : '') + '</div></div>';
    }).join('');
    box.querySelectorAll('[data-fb-id]').forEach(function (el) {
      el.onclick = function () { fbInboxDetailId = el.getAttribute('data-fb-id'); renderAdminInbox(); };
    });
  }
  function renderAdminInboxDetail(box, x) {
    box.innerHTML =
      '<button class="pwa-btn sub" id="pwFbBack" style="margin-bottom:10px">← 一覧へもどる</button>' +
      '<div><span class="pw-fb-badge type">' + esc(FB_TYPE_LABELS[x.type] || 'お問い合わせ') + '</span>' +
      '<span class="pw-fb-badge ' + (x.status === 'read' ? 'read' : 'new') + '">' + (x.status === 'read' ? '既読' : '新着') + '</span></div>' +
      '<div style="font-weight:900;font-size:15.5px;margin-top:6px;word-break:break-word">' + esc(x.title || '（無題）') + '</div>' +
      '<div class="pwa-note" style="margin-top:4px">' + esc(x.fromName || '名無し') +
      (x.game ? ' ・ ' + esc(GAME_TITLES[x.game] || x.game) : '') + ' ・ ' + esc(fmtDateTime(x.createdAt)) + '</div>' +
      '<div class="pw-fb-body">' + esc(x.body || '') + '</div>' +
      (x.status !== 'read' ? '<button class="pwa-btn" id="pwFbRead" style="margin-top:12px">既読にする</button>' : '');
    $('pwFbBack').onclick = function () { fbInboxDetailId = null; renderAdminInbox(); };
    var rb = $('pwFbRead');
    if (rb) rb.onclick = function () {
      rb.disabled = true;
      fb.db.doc('feedback/' + x._id).set({ status: 'read' }, { merge: true }).then(function () {
        x.status = 'read';
        fbInboxDetailId = null;
        renderAdminInbox();
      }).catch(function () { rb.disabled = false; });
    };
  }

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
      setGate('sdk-down');
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
    /* ゲスト制限: gateState は pending | member | guest | sdk-down */
    gateState: function () { return gateState; },
    isGuest: function () { return gateState !== 'member'; },
    onGateChange: function (cb) {
      if (typeof cb === 'function') {
        gateCbs.push(cb);
        if (gateState !== 'pending') { try { cb(gateState); } catch (e) {} }
      }
    },
    /* friends.js が後から読み込まれた時に現在のゲートを引き直すための通知先登録 */
    _friendsReady: function () { pushGateToFriends(); },
    login: doLogin,
    signup: doSignup,
    logout: doLogout,
    /* v51〜 openModal/closeModal はアカウントドロワーの開閉（旧モーダル互換） */
    openModal: openModal,
    closeModal: closeModal,
    openDrawer: openModal,
    closeDrawer: closeModal,
    drawerOpen: function () { return drawerOpen; },
    syncNow: function () { return syncSaves(); },
    searchUser: searchUser,
    addFriendByUsername: addFriendByUsername,
    sendInviteCloud: sendInviteCloud,
    sendChatCloud: sendChatCloud,
    canCloudChat: canCloudChat,
    consumeInvite: consumeInvite,
    dismissInvite: dismissInvite,
    /* v52〜 プロフィール */
    profileIcon: profileIconHTML,
    iconPresets: function () { return PROFILE_ICONS.slice(); },
    colorPresets: function () { return PROFILE_COLORS.slice(); },
    myProfile: function () {
      return {
        iconId: myProfile.iconId, iconColor: myProfile.iconColor,
        comment: myProfile.comment, stats: myProfile.stats, mainChar: myProfile.mainChar
      };
    },
    setMyProfile: setMyProfile,
    openProfile: openProfile,
    relLastSeen: function (d) { return relLastSeenText(d); },
    /* v52〜 フィードバック/意見ボックス */
    isAdmin: isAdmin,
    openFeedback: openFeedback,
    submitFeedback: submitFeedback,
    /* テスト用フック */
    _test: {
      syncableKey: syncableKey,
      collectLocal: collectLocal,
      hashStr: hashStr,
      mergeFriends: mergeFriends,
      friendsListHash: friendsListHash,
      meta: function () { return meta; },
      dirtyKeys: function () { return dirtyKeys; },
      guestActive: function () { return guestActive; },
      memStore: function () { var c = {}; Object.keys(memStore).forEach(function (k) { c[k] = memStore[k]; }); return c; },
      flushGuestStoreDiskFirst: flushGuestStoreDiskFirst,
      readHint: readHint,
      computeStats: computeMyStats,
      readMainChar: readMainChar,
      publishExtras: publishProfileExtras,
      setAdminUids: function (arr) {
        ADMIN_UIDS = (arr || []).slice();
        refreshAdminUI();
        if (cloudActive()) startAdminInbox();
      },
      adminUids: function () { return ADMIN_UIDS.slice(); },
      inboxItems: function () { return fbInboxItems.slice(); }
    }
  };

  /* ---------------- 初期化 ---------------- */
  function init() {
    buildUI();
    /* ポータル等のゲスト案内にあるログインボタンを結線し、表示状態を初期化する */
    try {
      document.querySelectorAll('[data-pw-login-btn]').forEach(function (b) {
        b.addEventListener('click', function () { openModal(); });
      });
      /* ポータル等のフィードバックボタンを結線（ゲストでも開ける） */
      document.querySelectorAll('[data-pw-feedback-btn]').forEach(function (b) {
        b.addEventListener('click', function () { openFeedback(); });
      });
    } catch (e) {}
    applyMemberOnlyVisibility();
    initFirebase().then(function (ok) {
      if (ok) startAuth();
      else { sdkState = 'unavailable'; setGate('sdk-down'); updatePill(); updateModal(); }
    }).catch(function () {
      sdkState = 'unavailable';
      setGate('sdk-down');
      updatePill(); updateModal();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
