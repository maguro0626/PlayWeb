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
   - クラウドセーブ（v66〜 アカウントごとのクラウド専管方式）:
     ゲームデータの保存先は「メモリ＋Firestore のみ」。実 localStorage には
     一切書かない（Firebase Auth のセッション保持だけは認証の仕組みとして対象外）。
     ログイン時に users/{uid}/saves/{encodeURIComponent(key)} の全キーを
     メモリへ読み込み（ハイドレーション）、書き込みはメモリへ即時反映＋
     Firestore へデバウンス保存する。ページ遷移をまたぐ引き継ぎは
     window.name（タブ内のみ・ディスクに残らない）経由で行い、遷移先では
     ゲーム初期化前にメモリへ種付けする。ログアウト/アカウント切替では
     メモリを破棄し、次のアカウントは自分のクラウドだけから読み直す。
     旧方式（v49〜v65: localStorage を実ストアにした時刻比較同期、
     新規登録時の「初回移行アップロード」、適用前の退避）は、アカウント間の
     データ混入の原因になったため v66 で全廃した。新規登録したアカウントは
     必ず空のクラウドから始まる。起動時には PlayWeb の既知キーを実
     localStorage から削除する（パージ。クラウドへ退避アップロードはしない）。
   - フレンド基盤（ログイン時）: フレンド一覧は users/{uid}/data/friends と同期し、
     ユーザー名検索で追加できる。プレゼンスは公開プロフィールの
     online/lastSeen/currentGame をハートビート更新して使う。
     招待は invites コレクション（オフラインでも届く）、チャットは
     messages コレクション（当事者のみ）に保存する。実際の対戦接続は
     従来どおり PeerJS ルームへ合流する。
   - ゲスト制限（v50〜）: 未ログイン（ゲスト）は1人用モードのみ。
     マルチプレイ・フレンド機能は使えず、セーブデータは保存されない。
     実装は2層: (1) 保存シム — v66 からはログイン状態によらず常時有効で、
     ゲーム系キーへの localStorage 読み書きは全てメモリ内ストアへ振り替える
     （実 localStorage は Firebase Auth のキー以外に触れない）。
     ゲストのデータはメモリ内だけにあり、リロードで消える。
     (2) ゲート — friends.js へ gateState（pending/member/guest/sdk-down）を
     通知し、フレンドUI・招待・オンライン入口を制御する。SDK が読み込めない
     環境ではログインできないため、マルチ/フレンドはゲスト扱いでブロックする。
   - セーブデータ初期化（v66〜）: ドロワーに「セーブデータを初期化」ボタンを
     置き、自分の users/{uid}/saves/ 全削除＋公開戦績のリセットができる
     （アカウント混入時に白紙へ戻す用途）。
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
  /* セーブ同期から外すキー: フレンド一覧は users/{uid}/data/friends の専用経路、
     チャット系2キーは v55 で機能廃止済みの残骸（同期せず、パージ対象）。
     playweb_profile（フレンド表示名）は v66 から通常のセーブとして同期する */
  var FRIENDS_KEYS = {
    playweb_friends: true, playweb_chats: true, playweb_unread: true
  };
  /* 起動時パージ: 実 localStorage から削除する PlayWeb の既知キー全覧
     （各ゲームのセーブ/設定/ベスト記録、ポータル、フレンド層、旧 account.js
     内部キー）。コード全体の localStorage 使用箇所から洗い出した一覧で、
     接頭辞ファミリは PURGE_PREFIXES 側に置く。Firebase Auth のキー
     （firebase:〜）と、同一オリジン上の他アプリのキーは対象外 */
  var PURGE_KEYS = [
    'blockblast_best', 'blockblast_state', 'blockblast_unlocked',
    'blockzushi_best', 'crepe_gallery',
    'daihugou_settings_v1', 'daihugou_sound_v1', 'daihugou_stats_v1',
    'frostline_best_v1', 'frostline_mute', 'frostline_save_v1',
    'gamedev_story_v1', 'gamedev_story_vs',
    'jumpDashProSaveV1', 'linksaga_save_v1',
    'majan2_settings',
    'majoneko_mute', 'majoneko_radar',
    'majoneko_survivors_best', 'majoneko_survivors_best_coop', 'majoneko_survivors_meta',
    'mini_calc_v1', 'mini_dice_v1', 'mini_janken_v1', 'mini_mash_v1', 'mini_memory_v1',
    'mini_mole_v1', 'mini_numguess_v1', 'mini_reaction_v1', 'mini_simon_v1', 'mini_timing_v1',
    'monster_caring_log_v1', 'monster_caring_name', 'monster_caring_slots_v1',
    'monster_caring_sound', 'monster_caring_v2',
    'mrise_settings', 'mrise_unified_v1', 'mrise_unified_v1_slot2', 'mrise_unified_v1_slot3',
    'mrise_v5', 'mrise_v5_slot2', 'mrise_v5_slot3',
    'playweb_chats', 'playweb_friends', 'playweb_pre_import_backup',
    'playweb_profile', 'playweb_records', 'playweb_unread',
    'pw_favs', 'pw_recent',
    'reversi_record_v1', 'reversi_settings_v1',
    'serenata_global_album', 'serenata_global_endings', 'serenata_settings',
    'suica_dx_highscore', 'tetris_best',
    'uno_settings_v2', 'uno_stats_v2',
    'pwacct_friends_reset_v50', 'pwacct_hint', 'pwacct_meta'
  ];
  var PURGE_PREFIXES = ['ms_best_', 'pwmatch_', 'serenata_save_slot_'];
  var PURGE_KEY_SET = {};
  PURGE_KEYS.forEach(function (k) { PURGE_KEY_SET[k] = true; });
  /* ページ遷移をまたぐ引き継ぎ（window.name）の形式 */
  var STASH_PREFIX = '__pwacct_stash_v1__:';
  var STASH_MAX = 1500000; /* これを超える場合は引き継ぎを諦める（正しさはクラウドが担保） */
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
  var UPLOAD_DEBOUNCE_MS = 400;
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

  /* ---------------- ピンチ拡縮の抑止（v55〜・全ページ共通） ----------------
     各ページの viewport メタ（maximum-scale=1.0, user-scalable=no）に加え、
     iOS Safari が user-scalable=no を無視するケースへの実行時補強。
     止めるのは「拡縮」だけに限定する:
       - gesturestart / gesturechange / gestureend（iOS 独自イベント）を抑止
       - 2本指以上の touchmove だけを抑止（ピンチ操作そのもの）
     1本指のタッチ・スワイプ・ドラッグ（仮想ジョイスティック等）や
     ポインタイベントには一切干渉しない。 */
  (function installPinchGuard() {
    try {
      ['gesturestart', 'gesturechange', 'gestureend'].forEach(function (ev) {
        document.addEventListener(ev, function (e) { e.preventDefault(); }, { passive: false });
      });
      document.addEventListener('touchmove', function (e) {
        if (e.touches && e.touches.length > 1 && e.cancelable) e.preventDefault();
      }, { passive: false });
    } catch (e) {}
  })();

  /* ---------------- 履歴ガード（全ページ共通） ----------------
     ブラウザ自体の「戻る」操作（左端スワイプ等）で、ゲーム中にうっかり
     前のページ（ポータル等）へ戻ってしまう誤操作を防ぐ。アプリ側の画面
     遷移は通常のリンク移動で、ゲーム内のタブ切り替え等も履歴 API を
     使わないため、読み込み時にガード用エントリを1つ積み、popstate が
     発火したら即座に積み直してその場に留まる。同一ドキュメント内の
     移動なのでページは再読み込みされず、対局・入力状態は保たれる。
     繰り返し「戻る」をしても、その都度ガードが消費→再装填される。
     ホームへの正規の導線は共通ヘッダーの 🏠 アイコンのまま。
     誤って戻ろうとした初回（1ページにつき1回）だけ、控えめな
     ヒントトーストを短時間出す。 */
  (function installHistoryGuard() {
    if (window.__pwHistoryGuard) return;
    window.__pwHistoryGuard = true;
    var hintShown = false;
    function armGuard() {
      /* reversi / crepe 等は棋譜・操作履歴に let history を使っており、
         素の history 参照がそちらへ解決されてしまうため、必ず
         window.history / window.location 経由で本物の履歴 API を使う */
      try { window.history.pushState({ pwHomeGuard: 1 }, '', window.location.href); } catch (e) {}
    }
    function showHint() {
      try {
        var el = document.getElementById('pwHistGuardHint');
        if (!el) {
          el = document.createElement('div');
          el.id = 'pwHistGuardHint';
          el.setAttribute('style',
            'position:fixed;left:50%;bottom:calc(84px + env(safe-area-inset-bottom, 0px));' +
            'transform:translate(-50%, 8px);z-index:2147483000;pointer-events:none;' +
            'background:rgba(18,20,36,.92);color:#fff;font-size:13px;line-height:1.45;' +
            'padding:9px 14px;border-radius:999px;box-shadow:0 4px 16px rgba(0,0,0,.35);' +
            'opacity:0;transition:opacity .25s ease,transform .25s ease;' +
            'max-width:88vw;text-align:center;white-space:nowrap;');
          el.textContent = 'ホームへは左上の 🏠 アイコンから戻れます';
          (document.body || document.documentElement).appendChild(el);
        }
        void el.offsetWidth;
        el.style.opacity = '1';
        el.style.transform = 'translate(-50%, 0)';
        clearTimeout(el.__pwHideT);
        el.__pwHideT = setTimeout(function () {
          el.style.opacity = '0';
          el.style.transform = 'translate(-50%, 8px)';
        }, 2600);
      } catch (e) {}
    }
    window.addEventListener('popstate', function () {
      armGuard();
      if (!hintShown) { hintShown = true; showHint(); }
    });
    armGuard();
  })();

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
     - firebase: で始まるキー（Firebase Auth のセッション永続化。
       認証の仕組みそのものなので保存層の対象外）
     それ以外のキーはログイン状態によらず全てメモリ内ストアへ振り替える */
  function shimExempt(k) {
    return k.indexOf('firebase:') === 0;
  }
  function diskKeys() {
    var out = [];
    try {
      for (var i = 0; i < window.localStorage.length; i++) {
        var k = window.localStorage.key(i);
        if (k) out.push(k);
      }
    } catch (e) {}
    return out;
  }
  /* ---------------- 起動時パージ（v66〜） ----------------
     旧方式が実 localStorage に残した PlayWeb のデータを削除する。
     起動のたびに冪等に実行する（マーカーキーは置かない＝それ自体が
     ブラウザに残るデータになるため）。パージ前にクラウドへ退避はしない
     （退避アップロード自体がアカウント混入の経路になるため）。 */
  (function purgePlayWebKeys() {
    try {
      diskKeys().forEach(function (k) {
        var hit = !!PURGE_KEY_SET[k];
        if (!hit) {
          for (var i = 0; i < PURGE_PREFIXES.length; i++) {
            if (k.indexOf(PURGE_PREFIXES[i]) === 0) { hit = true; break; }
          }
        }
        if (hit) diskRemove(k);
      });
    } catch (e) {}
  })();

  /* ---------------- メモリ内ストアとページ間引き継ぎ ----------------
     ゲームデータの実体はこのメモリ内ストアだけ。ページ遷移で消えないよう、
     ログイン中はハイドレーション済みデータを window.name に保持して
     遷移先ページの読み込み直後に同期的に種付けする（window.name は
     同一タブの遷移でのみ引き継がれ、タブを閉じれば消える。ディスクには
     一切書かれない）。種付けの採用条件は「Firebase Auth のセッション
     記録（firebase:authUser:*）の uid と引き継ぎデータの uid が一致する
     こと」。一致しなければ引き継ぎは破棄し、クラウドから読み直す。 */
  var memStore = {};   /* key -> string（唯一の保存先） */
  function authUidFromDisk() {
    try {
      var keys = diskKeys();
      for (var i = 0; i < keys.length; i++) {
        if (keys[i].indexOf('firebase:authUser:') === 0) {
          var rec = JSON.parse(diskGet(keys[i]) || 'null');
          if (rec && typeof rec.uid === 'string' && rec.uid) return rec.uid;
        }
      }
    } catch (e) {}
    return null;
  }
  var seededFromStash = false;
  var seedMap = null;   /* 種付けで採用した key -> 値（ハイドレーションとの整合判定用） */
  (function seedFromStash() {
    try {
      var raw = String(window.name || '');
      if (raw.indexOf(STASH_PREFIX) !== 0) return;
      var pack = null;
      try { pack = JSON.parse(raw.slice(STASH_PREFIX.length)); } catch (e) {}
      if (!pack || typeof pack !== 'object' || !pack.data || typeof pack.data !== 'object' || typeof pack.uid !== 'string') {
        window.name = '';
        return;
      }
      var auid = authUidFromDisk();
      if (!auid) return; /* 認証の手がかりが無い間は採用しない（ハイドレーションで確定させる） */
      if (pack.uid !== auid) { window.name = ''; return; } /* 別アカウントの引き継ぎは破棄 */
      seedMap = {};
      Object.keys(pack.data).forEach(function (k) {
        if (typeof pack.data[k] === 'string') { memStore[k] = pack.data[k]; seedMap[k] = pack.data[k]; }
      });
      seededFromStash = true;
    } catch (e) {}
  })();

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

  /* ---------------- 保存層の状態（v66: メモリ＋Firestore のみ） ----------------
     旧方式の同期メタ（pwacct_meta: ハッシュ/時刻/削除フラグ）は全廃した。
     競合解決は「ハイドレーション時点ではクラウドが正」という一方向だけに
     単純化し、以後の書き込みはメモリ→クラウドの一方通行にする。 */
  var hydratedUid = null;    /* ハイドレーションが完了した uid（これ以外ではアップロードしない） */
  var hydrating = false;
  var dirtyVals = {};        /* key -> string（未送信の値）| null（未送信の削除） */
  var pendingUploads = 0;    /* 送信中のセーブ数（復帰時リフレッシュの削除判定ガード） */
  var uploadTimer = null;
  var friendsUploadTimer = null;
  var stashTimer = null;

  /* window.name への引き継ぎを現在のメモリ内容で更新する（ログイン中のみ）。
     ゲストでは何も保持しない（リロードで消えるのが仕様）。 */
  function stashWrite() {
    try {
      if (!me) { stashClear(); return; }
      var data = {};
      Object.keys(memStore).forEach(function (k) { data[k] = memStore[k]; });
      var s = STASH_PREFIX + JSON.stringify({ uid: me.uid, ts: nowMs(), data: data });
      if (s.length > STASH_MAX) { stashClear(); return; }
      window.name = s;
    } catch (e) {}
  }
  function stashClear() {
    try { if (String(window.name || '').indexOf(STASH_PREFIX) === 0) window.name = ''; } catch (e) {}
  }
  function stashSchedule() {
    if (stashTimer) return;
    stashTimer = setTimeout(function () { stashTimer = null; stashWrite(); }, 600);
  }
  /* ハイドレーションが管理するキー範囲（同期対象＋フレンド一覧）の現在の
     メモリ内容を決定的に文字列化する（整合リロードの署名に使う） */
  function managedSignature() {
    var keys = Object.keys(memStore).filter(function (k) {
      return syncableKey(k) || k === 'playweb_friends';
    }).sort();
    return keys.map(function (k) { return k + '=' + memStore[k]; }).join('\n');
  }
  /* 書き込みをアップロード待ちにする。実際の送信はハイドレーション完了後だけ
     （完了前の書き込みは「クラウドに無いキー」に限って完了後に上げる。
     クラウドにあるキーへの完了前の書き込みは、ハイドレーションで
     クラウドの値に置き換わる＝破棄される） */
  function markDirty(key) {
    if (!syncableKey(key)) return;
    dirtyVals[key] = Object.prototype.hasOwnProperty.call(memStore, key) ? memStore[key] : null;
    scheduleUpload();
  }
  function scheduleUpload() {
    if (uploadTimer) return;
    uploadTimer = setTimeout(function () { uploadTimer = null; uploadDirty(); }, UPLOAD_DEBOUNCE_MS);
  }
  function flushUploads() {
    if (uploadTimer) { clearTimeout(uploadTimer); uploadTimer = null; }
    uploadDirty();
  }
  function scheduleFriendsUpload() {
    if (friendsUploadTimer) return;
    friendsUploadTimer = setTimeout(function () { friendsUploadTimer = null; uploadFriends(); }, UPLOAD_DEBOUNCE_MS);
  }

  /* ---------------- セーブ同期の対象判定 ---------------- */
  function syncableKey(k) {
    if (!k || typeof k !== 'string') return false;
    if (k.indexOf('firebase:') === 0) return false;   /* Firebase Auth 自体のキー */
    if (k.indexOf('pwacct_') === 0) return false;     /* account.js 内部キー（旧残骸含む） */
    if (k === 'playweb_pre_import_backup') return false; /* 旧方式の退避キー（廃止済み） */
    if (FRIENDS_KEYS[k]) return false;                /* フレンド層は専用経路で同期 */
    return true;
  }

  /* ---------------- アップロード（メモリ→Firestore の一方通行） ---------------- */
  function uploadDirty() {
    if (!me || !fb || hydratedUid !== me.uid) return;
    var keys = Object.keys(dirtyVals);
    if (!keys.length) return;
    var uid = me.uid;
    keys.forEach(function (k) {
      var v = dirtyVals[k];
      delete dirtyVals[k];
      pendingUploads++;
      var job = (v === null)
        ? saveDoc(uid, k).delete()
        : saveDoc(uid, k).set({ v: v, updatedAt: nowMs(), deleted: false });
      job.then(function () { pendingUploads--; }, function () {
        pendingUploads--;
        /* 失敗したら次回リトライ用に戻す（その間に新しい値が来ていればそちらを優先） */
        if (!Object.prototype.hasOwnProperty.call(dirtyVals, k)) dirtyVals[k] = v;
      });
    });
  }

  /* ---------------- ハイドレーション（Firestore→メモリ） ----------------
     ログイン時にそのアカウントのセーブ全キーとフレンド一覧をメモリへ読み込む。
     この時点ではクラウドが正:
       - クラウドにあるキー → メモリをクラウドの値にする
         （読み込み待ちの間にゲームが書いた初期値などは破棄される）
       - クラウドに無いキーで、読み込み待ちの間に書かれたもの → 残して後で上げる
       - クラウドに無く、未送信でもないメモリ上のキー（他端末で削除された等）
         → メモリからも消す（送信中のものがある間は安全のため消さない）
     ゲームは初期化時にメモリを読んで描画するため、ページ開始時点の内容
     （種付けされた内容、または空）とハイドレーションで確定した内容が
     食い違うと、初期表示だけが古いまま残る（判定など読み直す箇所は正しく
     なる）。そのため、確定内容が開始時点と異なる場合は1回だけ再読み込み
     して、正しいデータで初期化し直す。種付け内容と完全一致する通常遷移
     では再読み込みしない。再読み込みのガードは「ページ×確定内容の署名」
     単位で、同じ組み合わせの再要求だけを抑止する（セッション中ずっと
     塞ぐと、後から開いたページが二度と整合できなくなるため）。整合が
     取れたらガードは解除し、将来の本物の不整合に備える。
     opts.soft: フォーカス復帰時の再読み込み用（再読み込みはしない）。 */
  function hydrateSaves(opts) {
    opts = opts || {};
    if (!me || !fb || hydrating) return Promise.resolve(false);
    if (hydratedUid === me.uid && !opts.force) return Promise.resolve(true);
    hydrating = true;
    var uid = me.uid;
    setStatus('セーブデータを読み込み中…');
    var savesP = savesCol(uid).get().then(function (snap) {
      var cloud = {};
      snap.forEach(function (d) {
        var data = d.data() || {};
        if (data.deleted) return;               /* 旧方式の削除トンボストーンは無視 */
        if (typeof data.v !== 'string') return;
        try { cloud[decodeURIComponent(d.id)] = data.v; } catch (e) {}
      });
      return cloud;
    });
    var friendsP = friendsDoc(uid).get().then(function (d) {
      return (d.exists && d.data() && Array.isArray(d.data().list)) ? d.data().list : [];
    }).catch(function () { return null; });      /* 取得失敗時はフレンドに触らない */
    return Promise.all([savesP, friendsP]).then(function (res) {
      hydrating = false;
      if (!me || me.uid !== uid) return false;   /* 途中でログアウト/切替した */
      var cloud = res[0], friendsList = res[1];
      var changed = false;
      /* 種付け内容との食い違い（シード済みページ用）。ゲームはシードで
         初期化しているため、ハイドレーションがシードと違う値に確定させた
         キーが1つでもあれば初期表示が古いままになる */
      var diverged = false;
      Object.keys(cloud).forEach(function (k) {
        if (!syncableKey(k)) return;
        delete dirtyVals[k];                     /* クラウドにあるキーはクラウドが正 */
        if (memStore[k] !== cloud[k]) { memStore[k] = cloud[k]; changed = true; }
        if (seedMap && seedMap[k] !== cloud[k]) diverged = true;
      });
      if (pendingUploads === 0) {
        Object.keys(memStore).forEach(function (k) {
          if (!syncableKey(k)) return;
          if (Object.prototype.hasOwnProperty.call(cloud, k)) return;
          if (Object.prototype.hasOwnProperty.call(dirtyVals, k)) return;
          if (seedMap && Object.prototype.hasOwnProperty.call(seedMap, k)) diverged = true;
          delete memStore[k]; changed = true;
        });
      }
      if (friendsList && !friendsLocalDirty) {
        var fj = JSON.stringify(friendsList);
        if (memStore['playweb_friends'] !== fj) { memStore['playweb_friends'] = fj; changed = true; }
        if (seedMap && seedMap['playweb_friends'] !== fj) diverged = true;
        applyFriendsToLocal(friendsList);
        refreshPresenceWatch();
      }
      hydratedUid = uid;
      stashWrite();
      setStatus('クラウドセーブ有効');
      publishProfileExtras();
      flushUploads();
      if (friendsLocalDirty) uploadFriends(); /* ハイドレーション待ちの間のローカル変更を上げる */
      if (!opts.soft) {
        /* v68: ハイドレーション後の自動リロードは廃止した（実機で読み込みの
           たびに内容署名が変わり、リロードが無限に繰り返される不具合が
           あったため）。初期表示の整合は、シード（window.name）を書込み時と
           ページ離脱時に最新化することで担保する。残っていたガードも解除する */
        clearReloadGuard();
      }
      return true;
    }).catch(function () {
      hydrating = false;
      setStatus('セーブの読み込みに失敗しました（通信環境を確認してください）');
      return false;
    });
  }

  /* ---------------- セーブデータ初期化（v66〜） ----------------
     自分のクラウドセーブ全削除＋公開戦績のリセット。アカウント混入時に
     白紙へ戻すための機能で、他人のデータには一切触らない。 */
  function resetMyData() {
    if (!me || !fb) return Promise.resolve({ ok: false, msg: 'ログインが必要です' });
    var uid = me.uid;
    return savesCol(uid).get().then(function (snap) {
      var jobs = [];
      snap.forEach(function (d) {
        try { jobs.push(saveDoc(uid, decodeURIComponent(d.id)).delete()); } catch (e) {}
      });
      return Promise.all(jobs);
    }).then(function () {
      return userDoc(uid).set({ stats: {}, mainChar: '' }, { merge: true });
    }).then(function () {
      memStore = {};
      dirtyVals = {};
      lastExtrasJson = '';
      myProfile.stats = {};
      myProfile.mainChar = '';
      stashWrite();
      return { ok: true };
    }).catch(function (e) {
      return { ok: false, msg: '初期化に失敗しました' + (e && e.code ? '（' + e.code + '）' : '') };
    });
  }

  /* ---------------- localStorage のメモリ化（保存シム・v66〜常時有効） ----------------
     Storage.prototype を差し替え、localStorage への読み書きを（firebase: で
     始まる認証キーを除き）全てメモリ内ストアへ振り替える。ログイン状態に
     よらず常時有効で、実 localStorage には何も書かれない。書き込みは
     フックで検知し、アップロード予約とページ間引き継ぎの更新を行う。
     sessionStorage には干渉しない。 */
  function onLocalWrite(key, value) {
    /* 戦績・リンクサーガのセーブが変わったらプロフィール集計の再 publish を予約 */
    if (key === 'playweb_records' || key === 'linksaga_save_v1') schedulePublishExtras();
    stashSchedule();
    if (key === 'playweb_friends') {
      if (!applyingFriends) friendsLocalDirty = true;
      scheduleFriendsUpload();
      return;
    }
    markDirty(key);
  }
  function onLocalRemove(key) {
    stashSchedule();
    if (key === 'playweb_friends') {
      if (!applyingFriends) friendsLocalDirty = true;
      scheduleFriendsUpload();
      return;
    }
    markDirty(key);
  }
  (function patchStorage() {
    try {
      var proto = window.Storage && Storage.prototype;
      if (!proto || proto.__pwAcctPatched) return;
      var origGet = proto.getItem, origSet = proto.setItem,
          origRemove = proto.removeItem, origClear = proto.clear;
      proto.getItem = function (k) {
        if (this === window.localStorage && !shimExempt(String(k))) {
          var key = String(k);
          return Object.prototype.hasOwnProperty.call(memStore, key) ? memStore[key] : null;
        }
        return origGet.apply(this, arguments);
      };
      proto.setItem = function (k, v) {
        if (this === window.localStorage && !shimExempt(String(k))) {
          memStore[String(k)] = String(v);
          try { onLocalWrite(String(k), String(v)); } catch (e) {}
          return undefined;
        }
        return origSet.apply(this, arguments);
      };
      proto.removeItem = function (k) {
        if (this === window.localStorage && !shimExempt(String(k))) {
          if (Object.prototype.hasOwnProperty.call(memStore, String(k))) {
            delete memStore[String(k)];
            try { onLocalRemove(String(k)); } catch (e) {}
          }
          return undefined;
        }
        return origRemove.apply(this, arguments);
      };
      proto.clear = function () {
        if (this === window.localStorage) {
          /* メモリを空にする。実ディスク側も（認証キーを除き）掃除して
             「ブラウザにデータを残さない」を保証する */
          var keys = Object.keys(memStore);
          memStore = {};
          keys.forEach(function (k) { try { onLocalRemove(k); } catch (e) {} });
          try {
            diskKeys().forEach(function (k) { if (!shimExempt(k)) diskRemove(k); });
          } catch (e) {}
          return undefined;
        }
        return origClear.apply(this, arguments);
      };
      proto.__pwAcctPatched = true;
    } catch (e) {}
  })();

  /* ---------------- Firestore 参照ヘルパ ---------------- */
  function userDoc(uid) { return fb.db.doc('users/' + uid); }
  function savesCol(uid) { return fb.db.collection('users/' + uid + '/saves'); }
  function saveDoc(uid, key) { return fb.db.doc('users/' + uid + '/saves/' + encodeURIComponent(key)); }
  function friendsDoc(uid) { return fb.db.doc('users/' + uid + '/data/friends'); }

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
  /* フレンド一覧はクラウド（users/{uid}/data/friends）が正（v66〜）。
     旧方式の「ローカルとクラウドのマージ」は、アカウント間でフレンドが
     混ざる経路になるため廃止し、常にクラウドの内容で置き換える。
     ローカル側の変更（追加/削除）は friends.js 経由でメモリへ入り、
     uploadFriends がそのままクラウドへ書き戻す（lastFriendsHash で
     クラウド適用時のエコーを抑止する）。 */
  var applyingFriends = false;
  var friendsLocalDirty = false;   /* ローカルで変更済み・未アップロードのフレンド一覧がある */
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
  }
  function uploadFriends() {
    if (!cloudActive() || applyingFriends) return;
    if (hydratedUid !== me.uid) return; /* ハイドレーション前はクラウドが正（空で上書きしない） */
    var list = localFriends();
    var h = friendsListHash(list);
    if (h === lastFriendsHash) { friendsLocalDirty = false; return; }
    lastFriendsHash = h;
    friendsDoc(me.uid).set({ list: list, updatedAt: nowMs() })
      .then(function () { friendsLocalDirty = false; })
      .catch(function () { lastFriendsHash = ''; /* 次回リトライ */ });
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

  /* ---------------- チャット（v55 で機能削除） ----------------
     1対1チャットはユーザーの判断で廃止した。Firestore の messages
     コレクションはもう購読も送信もしない（ルール側は変更していない）。
     旧 pwacct_meta に残っていた chatSeen 等も v66 でメタごと全廃した。 */

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
    /* セーブとフレンド一覧をクラウドからメモリへ読み込む
       （ハイドレーション完了時に戦績集計の publish まで行う） */
    hydrateSaves();
    startAdminInbox();
    /* フレンド一覧の購読: クラウドの内容でそのまま置き換える（マージしない） */
    var fu = friendsDoc(me.uid).onSnapshot(function (d) {
      if (!d.exists) return;
      if (friendsLocalDirty) return; /* ローカルの未送信変更を守る（送信側が勝つ） */
      var cloudList = (d.data() && Array.isArray(d.data().list)) ? d.data().list : [];
      if (friendsListHash(cloudList) === lastFriendsHash) return;
      applyFriendsToLocal(cloudList);
      refreshPresenceWatch();
    }, function () {});
    unsubs.push(fu);
    startInviteListener();
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
    /* 戻ってきたら即ハートビートでオンライン復帰＋必要ならクラウドを読み直す */
    if (cloudActive()) heartbeat();
    if (document.visibilityState === 'visible' && cloudActive() && nowMs() - lastPullAt > 30000) {
      lastPullAt = nowMs();
      hydrateSaves({ force: true, soft: true });
    }
  });
  window.addEventListener('beforeunload', function () {
    /* 離脱直前にも引き継ぎ（window.name）を最新化する。デバウンス待ちの
       書き込みが残っていると、遷移先・再読み込み先が古いシードで初期化
       されてしまうため */
    stashWrite();
    flushUploads();
    if (cloudActive()) setOffline();
  });
  window.addEventListener('pagehide', function () {
    stashWrite();
    flushUploads();
    if (cloudActive()) setOffline();
  });

  /* ---------------- 認証アクション ---------------- */
  /* 登録・ログインの最中は onAuthUser 側の自動処理を抑え、ハンドラ側で
     メモリを破棄してから onAuthUser を明示的に駆動する（再読み込みはしない。
     ページ内のゲームはメモリの読み直し＋必要に応じたハイドレーション後の
     1回だけの再読み込みで整合する） */
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
        /* 新アカウントは必ず空のクラウドから始める。ゲスト中に遊んだ分の
           メモリはここで破棄し、旧方式の「初回移行アップロード」はしない。
           そのまま onAuthUser を駆動してハイドレーション（空）を開始する */
        memStore = {};
        dirtyVals = {};
        hydratedUid = null;
        stashClear();
        authTransition = null;
        onAuthUser(cred.user);
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
      .then(function (cred) {
        /* ゲスト中に遊んだ分は破棄する（アカウントのデータはクラウドだけが正。
           ゲスト分でクラウドを上書きしない）。そのまま onAuthUser を駆動し、
           このアカウントのクラウドからハイドレーションする */
        memStore = {};
        dirtyVals = {};
        hydratedUid = null;
        stashClear();
        authTransition = null;
        if (cred && cred.user) onAuthUser(cred.user);
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
    /* メモリ内ストアと引き継ぎを破棄してゲスト化する。以後の保存は
       ゲスト用メモリ（このページ限り）だけになり、クラウドのデータは
       次回ログイン時にそのアカウント分だけ読み直される */
    hydratedUid = null;
    memStore = {};
    dirtyVals = {};
    stashClear();
    setGate('guest');
    updatePill(); updateModal(); updateSearchRow();
    return fb.auth.signOut().catch(function () {});
  }
  function onAuthUser(user) {
    if (!user) {
      /* ログアウト/セッション切れ: メモリと引き継ぎを破棄してゲスト化する。
         ディスクには何も無いので、再読み込みで隠すような処理は不要 */
      if (me) { stopServices(); me = null; }
      hydratedUid = null;
      memStore = {};
      dirtyVals = {};
      stashClear();
      setGate(sdkState === 'unavailable' ? 'sdk-down' : 'guest');
      updatePill(); updateModal(); updateSearchRow();
      return;
    }
    /* 陳腐化した認証イベントのガード: 名前確保に失敗して認証ユーザーを
       巻き戻した直後など、既にサインアウト済みのユーザーに対する遅延イベントが
       届くことがある。現在のセッションが無いならそのイベントは無視する
       （ゲスト扱いのままにして、誤った再読み込みを防ぐ） */
    if (fb && fb.auth && !fb.auth.currentUser) return;
    if (authTransition) {
      /* 登録・ログインのハンドラがメモリ破棄と再駆動を担当する。ここでは
         サービスを開始しない（ハイドレーション前の状態で同期が走るのを防ぐ） */
      var tname = pendingUsername || (user.email || '').split('@')[0] || 'player';
      me = { uid: user.uid, username: tname, usernameLower: tname.toLowerCase() };
      setGate('member');
      updatePill(); updateModal(); updateSearchRow();
      return;
    }
    if (me && me.uid === user.uid && servicesOn) { setGate('member'); return; }
    if (me && me.uid !== user.uid) {
      /* アカウント切替: 前のアカウントのメモリと引き継ぎを破棄する */
      stopServices();
      me = null;
      hydratedUid = null;
      memStore = {};
      dirtyVals = {};
      stashClear();
    }
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
    '#pwDrawer{position:absolute;top:var(--pw-header-h,46px);right:0;bottom:0;width:min(400px,88vw);background:rgba(13,16,32,.9);backdrop-filter:blur(12px);border-left:1px solid rgba(255,255,255,.13);box-shadow:-18px 0 44px rgba(0,0,0,.5);color:#eef0ff;padding:16px 16px 30px;overflow-y:auto;overscroll-behavior:none;transform:translateX(106%);transition:transform .32s cubic-bezier(.32,.72,.24,1);-webkit-overflow-scrolling:touch;pointer-events:none}',
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
      body.innerHTML = '<div class="pwa-note err">ログイン機能を読み込めませんでした（通信環境を確認してください）。この環境ではゲスト扱いとなり、1人用モードのみ遊べます（マルチプレイ・フレンド・セーブ保存は使えません）。セーブはクラウドに保存されているので、通信が回復してログインすれば続きが遊べます。</div>';
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
        '<div class="pwa-note">セーブデータ・フレンド・戦績は、このアカウントのクラウドにだけ保存されます（ブラウザには残りません）。別の端末で同じアカウントにログインすると続きが遊べます。</div>' +
        '<button class="pwa-btn sub" id="pwaFeedbackBtn" style="margin-top:12px">📮 お問い合わせ・要望・バグ報告</button>' +
        '<button class="pwa-btn sub" id="pwaLogout" style="margin-top:8px">ログアウト</button>' +
        '<div class="pwa-note">ログアウトするとゲストに戻ります。データはクラウドに残るので、再ログインすれば続きが遊べます。</div>' +
        '<button class="pwa-btn sub" id="pwaResetData" style="margin-top:14px;color:#fca5a5;border-color:rgba(239,68,68,.45)">🗑 セーブデータを初期化</button>' +
        '<div class="pwa-note">全ゲームのセーブと戦績をクラウドから完全に削除します（元に戻せません）。</div>';
      $('pwaLogout').onclick = function () { doLogout(); };
      $('pwaResetData').onclick = function () {
        var btn = $('pwaResetData');
        if (!window.confirm('セーブデータを初期化しますか？\n全ゲームのセーブと戦績がクラウドから完全に削除され、元に戻せません。')) return;
        btn.disabled = true;
        resetMyData().then(function (r) {
          if (r.ok) {
            window.alert('セーブデータを初期化しました');
            location.reload();
          } else {
            window.alert(r.msg || '初期化に失敗しました');
            btn.disabled = false;
          }
        });
      };
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
      note.textContent = 'ログイン中はフレンドの在席・招待がクラウド経由で届きます（相手がオフラインでも届きます）。';
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
    syncNow: function () { flushUploads(); return hydrateSaves({ force: true, soft: true }); },
    /* v66〜 自分のクラウドセーブ全削除＋公開戦績リセット */
    resetMyData: resetMyData,
    searchUser: searchUser,
    addFriendByUsername: addFriendByUsername,
    sendInviteCloud: sendInviteCloud,
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
      hashStr: hashStr,
      friendsListHash: friendsListHash,
      dirtyKeys: function () { var c = {}; Object.keys(dirtyVals).forEach(function (k) { c[k] = true; }); return c; },
      /* 保存シムがメモリへ振り替えているか（=ゲスト相当の分離状態か）。
         v66 では常時メモリ化のため、ログイン中は false / それ以外は true */
      guestActive: function () { return gateState !== 'member'; },
      memStore: function () { var c = {}; Object.keys(memStore).forEach(function (k) { c[k] = memStore[k]; }); return c; },
      hydratedUid: function () { return hydratedUid; },
      seededFromStash: function () { return seededFromStash; },
      purgeKeyList: function () { return PURGE_KEYS.slice(); },
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
