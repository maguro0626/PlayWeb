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
   - セーブ保存（v74〜 端末ストア＋所有者引き継ぎ＋クラウド同期）:
     ゲームデータの主保存は実 localStorage の素キー（〜v65 と同じ方式）。
     保存シムは素通し＋書き込みフック（同期メタの版上げ・dirty 追跡・
     戦績 publish 予約）だけを行い、読み書きの振り替えは一切しない。
     そのため、認証状態がどうであっても（ゲストでも、認証確定前でも）
     書いた値はその場で端末に残り、次のページでそのまま読める。
     アカウント分離は保存層ではなく「所有者引き継ぎ」で担保する:
     同期メタ "pwacct_meta_v2" = {owner, keys, del, friendsTs} の owner が
     「現在の端末ストアが属するアカウント uid」を表す。ログイン/登録の
     確定時、owner が未設定か自分なら通常の LWW マージを行い、owner が
     他人なら端末ストアの同期対象キーとフレンド一覧を全消去してから
     自分のクラウドセーブを全件ダウンロードして反映する（引き継ぎ）。
     他人のクラウドには一切触らない。新規登録（クラウドが空）なら
     端末は空から始まる。ログアウトでは端末ストアも owner も消さない。
     クラウド（users/{uid}/saves/{encodeURIComponent(key)}）はバックアップと
     端末間同期用で、マージはキーごとの updatedAt 比較（新しい方の勝ち）。
     クラウド取得に失敗してもローカルだけで完全に動作する。
     ※ v66〜v71 の「メモリ＋クラウド専管」、v72〜v73 の「アカウント別
       名前空間（pwsave:<uid>:〜）」はどちらも実機で保存が定着しない
       不具合が続いたため廃止した。名前空間方式は「書き込みは残るが、
       ページ初期化時点で uid を同期的に知る手段が無く（Firebase SDK の
       セッション記録は IndexedDB 側にある）、ゲームがゲスト前提で初期
       読みした値を後から上書き破壊する」ことが実ブラウザ診断で確定した。
       v74 ではログイン確定時に、そのアカウントの名前空間残骸
       （pwsave:<uid>:* / pwmeta:<uid>）を時刻比較で素キーへ救済
       インポートしてから削除する（1回きり・冪等）。
     ※ 消失経路の精査で入れたガード（保存方式の根幹は不変）:
       - 未ログインでも所有者がいる端末での書き込み/削除は、所有者の版
         として同期メタの時刻だけ記録する（認証確定前・ログアウト中の
         最新書き込みが、古い版のまま LWW でクラウドに負けるのを防ぐ。
         所有者がいない端末では従来どおり触らない）
       - updatedAt を持たないクラウド文書（ts=0）は、メタ記録の無い
         ローカル値を上書き・削除しない（ローカルを初版として上げる）
       - ログアウト/ログイン/登録の直前に、現ユーザーの未送信分を
         本人のクラウドへ上げ切る（上限2.5秒。引き継ぎ消去で未送信分
         まで消えるのを防ぐ）
       - 同期メタの版上げ時は、所有者が一致すればディスク上の最新メタを
         取り込んでから書く（複数ページ同時表示での版の巻き戻し防止）
   - フレンド基盤（ログイン時）: フレンド一覧は users/{uid}/data/friends と同期し、
     ユーザー名検索で追加できる。プレゼンスは公開プロフィールの
     online/lastSeen/currentGame をハートビート更新して使う。
     招待は invites コレクション（オフラインでも届く）、チャットは
     messages コレクション（当事者のみ）に保存する。実際の対戦接続は
     従来どおり PeerJS ルームへ合流する。
   - ゲスト制限（v50〜）: 未ログイン（ゲスト）は1人用モードのみ。
     マルチプレイ・フレンド機能は使えない。実装はゲートのみ:
     friends.js へ gateState（pending/member/guest/sdk-down）を通知し、
     フレンドUI・招待・オンライン入口を制御する。SDK が読み込めない
     環境ではログインできないため、マルチ/フレンドはゲスト扱いでブロックする。
     なお v74〜 ゲストのセーブも端末ストア（素キー）に保存される
     （保存層は認証状態で振る舞いを変えない）。ただし共有端末で
     ログアウトした後に次の人がゲストとして遊ぶと、前任者の端末データが
     見える点は設計上の割り切りとする（アカウント分離はログイン時の
     所有者引き継ぎで担保する）。
   - セーブデータ初期化（v66〜）: ドロワーに「セーブデータを初期化」ボタンを
     置き、自分の users/{uid}/saves/ 全削除＋この端末ストアの同期対象キー・
     フレンド全消去＋同期メタ初期化（owner 解除）＋公開戦績のリセットが
     できる（白紙へ戻す用途。他人のデータには一切触らない）。
   - バックアップから復元: ドロワーに「バックアップから復元」ボタンを置き、
     ポータルで書き出したバックアップ JSON（{exportedAt, data:{key:値}} 形式。
     旧退避形式 {savedAt, data} と素の key→値マップも可）を本人のアカウントへ
     取り込める。実行はログイン中のみ。取り込みは通常の保存経路（シム経由の
     書き込み→素キー→クラウド同期）で行うため、取り込んだ時点で端末には
     即永続化される。フレンドはフレンド経路、対象外キー
     （firebase:/pwacct_/旧仕様の死んだキー等）は取り込まない。
   - 共通ヘッダー＋ドロワー（v51〜）: 全ページ最上部に共通ヘッダー
     （🏠ホーム＋ゲーム名＋[メイン｜アカウント]タブ）を注入する。
     「アカウント」タブで右から半透明ドロワーがスライドインし、
     ログイン/登録/ログアウトとフレンド機能（friends.js が #pwFriendsMount
     にマウント）を集約表示する。旧・左下ピルとログインモーダル、
     friends.js の右下 FAB は廃止。PWAccount.openModal() はドロワーを開く。
     閉じたドロワーの残留対策: ラッパーは閉時 visibility:hidden（遅延つき
     transition）でヒットテスト自体を消し、スクリム/ドロワーには
     :not(.open) の pointer-events:none!important と開閉連動のインライン
     指定・inert を併用する（閉後に透明パネルがクリックを奪わない）。
     開閉は document へ 'pw:overlay' CustomEvent（detail.open/drawer/feedback）
     で通知し、ゲーム側がポーズ連動できる（PWAccount.overlayOpen /
     onOverlayChange でも取得可）。
   - v52〜 リアルタイム化の仕上げ＋プロフィール＋フィードバック:
     在席/チャット/招待は Firestore の onSnapshot 購読で即時反映する
     （ハートビートは30秒のまま。購読が即時化の本命で、間隔短縮は
     書き込み量と電池の無駄が大きい）。タブを隠す/閉じると即オフライン化。
     プロフィール: users/{uid} に iconId / iconColor / comment /
     stats（ゲーム別戦績の集計）/ mainChar（リンクドラムサーガの使用キャラ）を
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
     playweb_profile は v66 から通常のセーブとして同期する（旧・表示名の残骸。
     表示名は廃止済みで、もう name は書き込まれない） */
  var FRIENDS_KEYS = {
    playweb_friends: true, playweb_chats: true, playweb_unread: true
  };
  /* v74〜 同期メタは単一キー "pwacct_meta_v2" に集約する:
       { owner, keys:{K:updatedAt}, del:{K:updatedAt}, friendsTs }
     owner は「現在の端末ストアが属するアカウント uid」（未設定なら null）。
     v72/v73 の名前空間キー（"pwsave:<uid>:K" / "pwmeta:<uid>"）は廃止したが、
     端末に残っている分をログイン確定時に救済インポートするため、
     接頭辞だけは定数として残す（新規に書くことは二度とない） */
  var META_V2_KEY = 'pwacct_meta_v2';
  var SAVE_NS_PREFIX = 'pwsave:';   /* 旧方式の接頭辞（救済インポート専用） */
  var META_PREFIX = 'pwmeta:';      /* 旧方式の接頭辞（救済インポート専用） */
  var PRESENCE_STALE_MS = 300000;  /* lastSeen がこれより古ければオフライン扱い（ハートビート120秒間隔でも誤判定しないよう5分） */
  var HEARTBEAT_MS = 120000;       /* 在席ハートビート間隔。Firebase書き込み削減のため120秒（旧30秒＝最大2,880回/日→約720回/日） */
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
     保存シムは Storage.prototype を差し替えるため、account.js 自身が
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
  /* シムの対象外キー（フックも掛けず素通しする）:
     - firebase: で始まるキー（Firebase Auth のセッション永続化。
       認証の仕組みそのものなので保存層の対象外）
     それ以外のキー（ゲームの素キー）は v74〜 常に実ディスクの素キーへ
     素通しし、シムは書き込みフックだけを行う（振り替えはしない）。
     account.js 自身は同期メタ等を rawLS 経由で直接触るため、
     それらがシムを通ることはない */
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
  /* ---------------- 保存層（v74〜: 端末ストア＝素キー＋所有者引き継ぎ） ----
     ゲームデータの主保存は実 localStorage の素キーそのもの。保存シムは
     読み書きを一切振り替えず、書き込みフック（同期メタ・dirty 追跡）だけを
     行うため、認証状態に関係なく書いた値はその場で端末に残る。
     アカウント分離は保存層ではなく、ログイン確定時の所有者引き継ぎ
     （activateStoreForUser）が担保する。 */
  /* 端末ストアにあるゲーム系の素キー一覧。
     対象外: Firebase Auth のキー（firebase:〜）、account.js の内部キー
     （pwacct_〜。同期メタ pwacct_meta_v2 を含む）、旧名前空間の残骸
     （pwsave:〜 / pwmeta:〜。救済インポート専用で、ゲームのキーではない） */
  function storeKeys() {
    return diskKeys().filter(function (k) {
      if (k.indexOf('firebase:') === 0) return false;
      if (k.indexOf('pwacct_') === 0) return false;
      if (k.indexOf(SAVE_NS_PREFIX) === 0 || k.indexOf(META_PREFIX) === 0) return false;
      return true;
    });
  }
  /* 端末ストアの内容を {素キー: 値} で返す（書き出し・テスト用） */
  function storeSnapshot() {
    var out = {};
    storeKeys().forEach(function (k) {
      var v = diskGet(k);
      if (v !== null) out[k] = v;
    });
    return out;
  }
  /* 端末ストアの同期対象キーとフレンド一覧を全消去する（引き継ぎ・初期化用）。
     keep に入れたキーは消さない。Firebase Auth のキーと同期メタキー自体には
     触らない（メタの中身の初期化は呼び出し側が行う） */
  function wipeDeviceStore(keep) {
    keep = keep || {};
    diskKeys().forEach(function (k) {
      if (keep[k]) return;
      if (k.indexOf('firebase:') === 0) return;
      if (k === META_V2_KEY) return;
      if (syncableKey(k) || FRIENDS_KEYS[k]) diskRemove(k);
    });
  }

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
  /* リンクドラムサーガ（taiko）の使用キャラ名をセーブから読む。
     セーブ形式: { owned: {...}, fav: キャラid }（taiko_chara_v1）
     優先順: お気に入り(fav) → 編成の先頭 → 最もレベルの高い所持キャラ。
     名前が引けない id（未登録のもの）は表示しない（空文字を返す）。
     セーブが無いユーザーでは空文字を返すだけで壊れない。
     ※ id→名前の対応は旧リンクサーガから流用したロスター全26体分 */
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
      var s = JSON.parse(localStorage.getItem('taiko_chara_v1') || 'null');
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
  var myCreatedAtMs = null;   /* 自分のアカウント作成日時（ms）。未取得・不明は null */
  var lastExtrasJson = '';    /* stats/mainChar の publish 済み内容（無駄な書き込み防止） */
  var extrasTimer = null;

  function cloudActive() { return !!(me && servicesOn && fb); }

  /* ---------------- 保存層の状態（v74: 端末ストア＋クラウド同期） ----------------
     主保存は実 localStorage の素キーで、書き込みは認証状態に関係なく
     その場で永続化される。クラウドはバックアップ＋端末間同期用で、
     競合解決はキーごとの updatedAt 比較（新しい方の勝ち）。比較メタは
     単一キー pwacct_meta_v2 に保存するため、ページをまたいでも台帳が
     失われることはない。 */
  var mergedUid = null;      /* クラウドとのマージ（初期同期）が完了した uid。
                                アップロードはこの uid に対してだけ行う */
  var merging = false;
  var syncGen = 0;           /* 同期の世代。所有者の引き継ぎとセーブ初期化で
                                進み、進行中のマージの適用を無効化する */
  var storeOwner = null;     /* activateStoreForUser が最後に処理した uid。
                                syncMeta.owner と一致させる（再入防止用） */
  var resettingUid = null;   /* セーブ初期化の実行中 uid（その間アップロードを止める） */
  var dirtyKeys = {};        /* key -> true。このセッションでまだクラウドへ
                                上がっていないローカル変更（再送スケジュール用。
                                正しさの担保はディスク上のメタが担う） */
  var uploadInFlight = {};   /* key -> 送信した updatedAt。二重送信防止用 */
  var pendingUploads = 0;    /* 送信中のセーブ数 */
  var ackWaiters = [];       /* flushUploads の完了待ち（全送信が settle したら解決） */
  var saveError = false;     /* 直近のアップロード失敗をステータスに出しているか */
  /* ローカル保存自体は即時成功している前提の文言にする */
  var SAVE_ERROR_MSG = 'クラウドへの同期に失敗しました（この端末には保存されています）';
  var uploadTimer = null;
  var friendsUploadTimer = null;

  /* ---------------- 同期メタ（v74〜 単一キー・実ディスク） ----------------
     pwacct_meta_v2 に JSON で保存する:
       { owner, keys: {K: updatedAt}, del: {K: updatedAt}, friendsTs: number }
     owner は「現在の端末ストアが属するアカウント uid」（未設定なら null）。
     keys/del は「この端末が知っている各キーの最新版の時刻」で、ログイン時の
     マージ比較に使う。フレンド一覧の版は friendsTs で別管理する
     （playweb_friends はセーブ同期の対象外キーのため）。 */
  var syncMeta = null;       /* 同期メタのメモリ上コピー（読み込み時に確定） */
  function blankMeta() { return { owner: null, keys: {}, del: {}, friendsTs: 0 }; }
  function loadMeta() {
    var m = blankMeta();
    try {
      var raw = diskGet(META_V2_KEY);
      if (raw) {
        var p = JSON.parse(raw);
        if (p && typeof p === 'object') {
          if (typeof p.owner === 'string' && p.owner) m.owner = p.owner;
          if (p.keys && typeof p.keys === 'object') m.keys = p.keys;
          if (p.del && typeof p.del === 'object') m.del = p.del;
          if (typeof p.friendsTs === 'number') m.friendsTs = p.friendsTs;
        }
      }
    } catch (e) {}
    return m;
  }
  function persistMeta() {
    if (!syncMeta) return;
    try { diskSet(META_V2_KEY, JSON.stringify(syncMeta)); } catch (e) {}
  }
  syncMeta = loadMeta();
  storeOwner = syncMeta.owner;
  /* ディスク上の最新メタを取り込む（複数ページ同時表示対策）。
     各ページは syncMeta の写しをメモリに持ち、書き込みのたびに写し全体を
     ディスクへ戻すため、古い写しを持つページの書き込みが、他ページが
     記録したキーの版を巻き戻してしまう（版が消えたキーは次回マージで
     「メタ無し」扱いになり、古いクラウド値に負け得る）。書き込みの版上げ
     の直前に、所有者が一致する場合だけディスク側の新しい版を取り込む。
     所有者が違う場合は他ページで引き継ぎが起きた後のため触らない */
  function refreshMetaFromDisk() {
    if (!syncMeta) { syncMeta = loadMeta(); return; }
    var fresh = loadMeta();
    if (fresh.owner !== syncMeta.owner) return;
    var win = {};   /* key -> {ts, del}（両写しのうち新しい方） */
    Object.keys(syncMeta.keys).forEach(function (k) { win[k] = { ts: syncMeta.keys[k], del: false }; });
    Object.keys(syncMeta.del).forEach(function (k) { win[k] = { ts: syncMeta.del[k], del: true }; });
    Object.keys(fresh.keys).forEach(function (k) {
      if (!win[k] || fresh.keys[k] > win[k].ts) win[k] = { ts: fresh.keys[k], del: false };
    });
    Object.keys(fresh.del).forEach(function (k) {
      if (!win[k] || fresh.del[k] > win[k].ts) win[k] = { ts: fresh.del[k], del: true };
    });
    syncMeta.keys = {}; syncMeta.del = {};
    Object.keys(win).forEach(function (k) {
      if (win[k].del) syncMeta.del[k] = win[k].ts; else syncMeta.keys[k] = win[k].ts;
    });
    if (fresh.friendsTs > (syncMeta.friendsTs || 0)) syncMeta.friendsTs = fresh.friendsTs;
  }
  /* ローカルへ値を書いた記録（そのキーの版を上げる） */
  function metaTouch(key, ts) {
    if (!syncMeta) return;
    refreshMetaFromDisk();
    syncMeta.keys[key] = ts;
    delete syncMeta.del[key];
    persistMeta();
  }
  /* ローカルで削除した記録（削除の版を上げる。クラウドへも伝播させる） */
  function metaDelete(key, ts) {
    if (!syncMeta) return;
    refreshMetaFromDisk();
    delete syncMeta.keys[key];
    syncMeta.del[key] = ts;
    persistMeta();
  }

  /* ---------------- v72/v73 名前空間の救済インポート ----------------
     ログイン確定時、そのアカウントの名前空間残骸（pwsave:<uid>:*）が
     端末に残っていれば、旧メタ（pwmeta:<uid>）の時刻と現メタを比べて
     新しい分だけを素キーへ取り込む。取り込み後に名前空間キーと旧メタを
     削除する（1回きりでよいが、再実行しても害がない冪等な形にする）。
     戻り値: 実際に素キーへ書き込んだキーの一覧（引き継ぎ時の保持判定用） */
  function importLegacyNamespace(uid) {
    var imported = [];
    try {
      if (!syncMeta) syncMeta = loadMeta();
      var pre = SAVE_NS_PREFIX + uid + ':';
      var legacyMeta = null;
      var rawMeta = diskGet(META_PREFIX + uid);
      if (rawMeta) { try { legacyMeta = JSON.parse(rawMeta); } catch (e) {} }
      var lk = (legacyMeta && legacyMeta.keys && typeof legacyMeta.keys === 'object') ? legacyMeta.keys : {};
      diskKeys().forEach(function (dk) {
        if (dk.indexOf(pre) !== 0) return;
        var k = dk.slice(pre.length);
        var v = diskGet(dk);
        if (v === null) return;
        if (k === 'playweb_friends') {
          var fts = (legacyMeta && typeof legacyMeta.friendsTs === 'number') ? legacyMeta.friendsTs : 0;
          if (fts > (syncMeta.friendsTs || 0)) {
            diskSet('playweb_friends', v);
            syncMeta.friendsTs = fts;
            friendsLocalDirty = true;
            imported.push(k);
          }
          return;
        }
        if (!syncableKey(k)) return;
        /* 旧メタに時刻が無い値は「この端末の現在の正」として扱う */
        var ts = (typeof lk[k] === 'number' && lk[k] > 0) ? lk[k] : nowMs();
        var curTs = (typeof syncMeta.keys[k] === 'number') ? syncMeta.keys[k] : -1;
        var curDel = (typeof syncMeta.del[k] === 'number') ? syncMeta.del[k] : -1;
        if (ts > Math.max(curTs, curDel)) {
          diskSet(k, v);
          syncMeta.keys[k] = ts;
          delete syncMeta.del[k];
          imported.push(k);
        }
      });
      /* 削除記録の取り込み（旧メタの del が現メタより新しいキー） */
      if (legacyMeta && legacyMeta.del && typeof legacyMeta.del === 'object') {
        Object.keys(legacyMeta.del).forEach(function (k) {
          if (!syncableKey(k)) return;
          var ts = legacyMeta.del[k];
          if (typeof ts !== 'number' || ts <= 0) return;
          var curTs = (typeof syncMeta.keys[k] === 'number') ? syncMeta.keys[k] : -1;
          var curDel = (typeof syncMeta.del[k] === 'number') ? syncMeta.del[k] : -1;
          if (ts > Math.max(curTs, curDel)) {
            diskRemove(k);
            delete syncMeta.keys[k];
            syncMeta.del[k] = ts;
          }
        });
      }
      if (imported.length) persistMeta();
      /* 後始末: 名前空間キーと旧メタを削除する（冪等） */
      diskKeys().forEach(function (dk) { if (dk.indexOf(pre) === 0) diskRemove(dk); });
      diskRemove(META_PREFIX + uid);
    } catch (e) {}
    return imported;
  }

  /* ---------------- 所有者の引き継ぎ（ログイン/登録確定時） ----------------
     端末ストアの所有者を、確定したアカウントへ合わせる:
       - owner が未設定 or 自分 → そのまま（この後の通常マージに任せる）
       - owner が他人 → 引き継ぎ: 端末ストアの同期対象キーとフレンド一覧を
         全消去し、メタを owner=自分 で初期化する。その後のマージで自分の
         クラウドセーブが全件ダウンロードされて端末へ反映される
         （新規登録＝クラウドが空なら、端末は空から始まる）。
         他人のクラウドには一切触らない。
     先に v72/v73 名前空間の救済インポートを行い、自分の名前空間から
     取り込んだ分は引き継ぎの全消去でも保持する（自分の直近の書き込みを
     守るため。それらはメタの版を持ってマージに臨み、新しければ上がる）。 */
  function activateStoreForUser(uid) {
    if (typeof uid !== 'string' || !uid) return;
    if (!syncMeta) syncMeta = loadMeta();
    /* 救済インポートは早期リターンより先に行う（owner が既に自分でも、
       名前空間残骸が残っていれば取り込む。残骸は取り込み時に消えるため、
       2回目以降は imported が空になり実質無動作） */
    var imported = importLegacyNamespace(uid);
    if (storeOwner === uid && syncMeta.owner === uid && !imported.length) return;
    syncGen++;
    mergedUid = null;
    dirtyKeys = {};
    saveError = false;
    friendsLocalDirty = false;
    lastFriendsHash = '';
    if (ackWaiters.length) {
      var ws = ackWaiters; ackWaiters = [];
      ws.forEach(function (r) { r({ ok: false, remaining: 0 }); });
    }
    if (syncMeta.owner && syncMeta.owner !== uid) {
      /* 引き継ぎ */
      var keep = {};
      var keptTs = {};
      imported.forEach(function (k) {
        keep[k] = true;
        if (k !== 'playweb_friends' && typeof syncMeta.keys[k] === 'number') keptTs[k] = syncMeta.keys[k];
      });
      var keptFriendsTs = keep['playweb_friends'] ? syncMeta.friendsTs : 0;
      wipeDeviceStore(keep);
      syncMeta = { owner: uid, keys: keptTs, del: {}, friendsTs: keptFriendsTs };
      persistMeta();
      friendsLocalDirty = !!keep['playweb_friends'];
      imported.forEach(function (k) { if (k !== 'playweb_friends') dirtyKeys[k] = true; });
    } else {
      if (syncMeta.owner !== uid) { syncMeta.owner = uid; persistMeta(); }
      imported.forEach(function (k) { if (k !== 'playweb_friends') dirtyKeys[k] = true; });
    }
    storeOwner = uid;
  }

  /* 書き込みをクラウド送信待ちにする（実送信はマージ完了後だけ。
     マージ前の書き込みはディスク＋メタに残っており、マージ時に新しい方と
     して扱われてアップロードされる） */
  function markDirty(key) {
    if (!syncableKey(key)) return;
    dirtyKeys[key] = true;
    scheduleUpload();
  }
  function scheduleUpload() {
    if (uploadTimer) return;
    uploadTimer = setTimeout(function () { uploadTimer = null; uploadDirty(); }, UPLOAD_DEBOUNCE_MS);
  }
  /* 未送信分が全て settle（送信中がゼロ）するまで待つ Promise。
     解決値 { ok, remaining }: ok はクラウドへ上がっていない変更が残って
     いないこと。残っている場合もデータ自体は端末に保存済みで、次回接続時
     （マージ・再送）で同期される */
  function uploadsSettled() {
    if (pendingUploads === 0) {
      var n = Object.keys(dirtyKeys).length;
      return Promise.resolve({ ok: n === 0, remaining: n });
    }
    return new Promise(function (res) { ackWaiters.push(res); });
  }
  function checkAckWaiters() {
    if (pendingUploads !== 0 || !ackWaiters.length) return;
    var n = Object.keys(dirtyKeys).length;
    var res = { ok: n === 0, remaining: n };
    var ws = ackWaiters; ackWaiters = [];
    ws.forEach(function (r) { r(res); });
  }
  /* 同期失敗を見える化する。連続失敗でステータスが荒れないよう、
     表示は「失敗状態への遷移時」だけ行い、持ち直したら通常表示へ戻す */
  function noteUploadFailure() {
    var first = !saveError;
    saveError = true;
    if (first) setStatus(SAVE_ERROR_MSG);
  }
  function noteUploadSuccess() {
    if (!saveError) return;
    if (pendingUploads !== 0 || Object.keys(dirtyKeys).length !== 0) return;
    saveError = false;
    if (statusText === SAVE_ERROR_MSG) setStatus('クラウドセーブ有効');
  }
  /* デバウンス待ちを即時送信し、現在の未送信分が全て ack されるまでを
     Promise で返す（呼び出し側は無視してもよい） */
  function flushUploads() {
    if (uploadTimer) { clearTimeout(uploadTimer); uploadTimer = null; }
    uploadDirty();
    return uploadsSettled();
  }
  /* 認証状態が変わる前（ログアウト／アカウント切替）に、現在ログイン中の
     ユーザーの未送信分を本人のクラウドへ上げ切る。デバウンス（400ms）待ちや
     送信失敗のまま認証が切り替わると、所有者引き継ぎの端末消去で未送信分
     ごと消え、本人のクラウドにも残らないため。切替後のユーザーでは他人
     （切替前ユーザー）のクラウドへは書けないので、このタイミングしかない。
     応答が無い送信で認証操作自体が固まらないよう上限時間を設ける
     （上限を超えた分は端末＋メタに残り、次回本人がログインした時の
     マージで必ず拾われる） */
  function flushBeforeAuthChange() {
    if (!me || !fb || mergedUid !== me.uid) return Promise.resolve();
    if (!Object.keys(dirtyKeys).length && pendingUploads === 0) return Promise.resolve();
    var settled = flushUploads();
    return Promise.race([
      settled,
      new Promise(function (res) { setTimeout(res, 2500); })
    ]);
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

  /* ---------------- アップロード（ローカル→Firestore） ----------------
     送信内容は送信時点のディスク（素キー）とメタから決める（常に最新）。
     送信した updatedAt はメタの時刻と一致させる（マージ比較の一貫性のため）。
     ack が返るまでキーは dirtyKeys に残し続ける。送信中に同じキーが
     書き換わっていたら（メタの時刻が進んでいたら）dirty に残して改めて送る。
     失敗したキーは dirtyKeys に残り、次の書き込み・flush・15秒間隔で
     再送されるほか、次回ログイン時のマージでも必ず拾われる。 */
  function uploadDirty() {
    if (!me || !fb || mergedUid !== me.uid || !syncMeta || syncMeta.owner !== me.uid) return;
    if (resettingUid && resettingUid === me.uid) return;   /* 初期化の最中は上げない（削除を蘇らせない） */
    var keys = Object.keys(dirtyKeys);
    if (!keys.length) return;
    var uid = me.uid;
    keys.forEach(function (k) {
      if (Object.prototype.hasOwnProperty.call(uploadInFlight, k)) return; /* 送信中は二重送信しない */
      var val = diskGet(k);
      var ts = (typeof syncMeta.keys[k] === 'number') ? syncMeta.keys[k] : null;
      var delTs = (typeof syncMeta.del[k] === 'number') ? syncMeta.del[k] : null;
      var job, sentTs;
      if (val !== null) {
        sentTs = (ts !== null ? ts : nowMs());
        job = saveDoc(uid, k).set({ v: val, updatedAt: sentTs, deleted: false });
      } else if (delTs !== null || ts !== null) {
        /* 端末に値が無く、削除（または版）の記録だけがある → クラウド側を消す */
        sentTs = (delTs !== null ? delTs : ts);
        job = saveDoc(uid, k).delete();
      } else {
        delete dirtyKeys[k];   /* 端末にもメタにも無い＝送るものが無い */
        return;
      }
      uploadInFlight[k] = sentTs;
      pendingUploads++;
      job.then(function () {
        pendingUploads--;
        delete uploadInFlight[k];
        /* ack: 送った版と現在の版が一致する時だけ送信待ちから外す。
           所有者が切り替わっていたら他人の状態には触らない */
        if (me && me.uid === uid && syncMeta && syncMeta.owner === uid) {
          var curTs = (val !== null) ? syncMeta.keys[k] : syncMeta.del[k];
          if (curTs === sentTs) delete dirtyKeys[k];
          else if (Object.prototype.hasOwnProperty.call(dirtyKeys, k)) scheduleUpload(); /* 送信中の新版を送る */
          noteUploadSuccess();
        }
        checkAckWaiters();
      }, function () {
        pendingUploads--;
        delete uploadInFlight[k];
        /* 失敗: キーは dirtyKeys に残ったまま。見える化する */
        if (me && me.uid === uid) noteUploadFailure();
        checkAckWaiters();
      });
    });
  }

  /* ---------------- クラウドとのマージ（ログイン確定時） ----------------
     ローカル（端末ストアの素キー＋メタ）とクラウド（users/{uid}/saves）を、
     キーごとに updatedAt を比較して新しい方へ揃える:
       - ローカルの値／削除 の方が新しい → そのまま残し、クラウドへ上げる
       - クラウドの値／削除 の方が新しい → 端末ストアとメタへ書き込む
       - ローカルにしか無いキー → 上げる（空の端末にはクラウドが落ちてくる）
     適用は「取得が終わった時点」のローカル状態に対して行うため、取得待ちの
     間に書かれた値（最新の updatedAt を持つ）も正しく勝ち残る。
     クラウド取得に失敗した場合はマージ自体を行わず、ローカルの値には
     一切触らない（ローカルだけで完全に動作する）。
     所有者が自分でない端末ストアとはマージしない（引き継ぎ前の状態で
     他人のデータと自分のクラウドを混ぜないため）。 */
  function mergeCloudSaves(opts) {
    opts = opts || {};
    if (!me || !fb || merging) return Promise.resolve(false);
    if (mergedUid === me.uid && !opts.force) return Promise.resolve(true);
    if (!syncMeta || syncMeta.owner !== me.uid) return Promise.resolve(false);
    merging = true;
    var uid = me.uid;
    var gen = syncGen;
    setStatus('セーブデータを読み込み中…');
    var savesP = savesCol(uid).get().then(function (snap) {
      var cloud = {};
      snap.forEach(function (d) {
        var data = d.data() || {};
        var key;
        try { key = decodeURIComponent(d.id); } catch (e) { return; }
        var ts = (typeof data.updatedAt === 'number' && isFinite(data.updatedAt)) ? data.updatedAt : 0;
        if (data.deleted) { cloud[key] = { del: true, ts: ts }; return; }
        if (typeof data.v !== 'string') return;
        cloud[key] = { v: data.v, ts: ts };
      });
      return cloud;
    });
    var friendsP = friendsDoc(uid).get().then(function (d) {
      if (!d.exists) return { list: [], ts: 0 };
      var data = d.data() || {};
      return {
        list: Array.isArray(data.list) ? data.list : [],
        ts: (typeof data.updatedAt === 'number' && isFinite(data.updatedAt)) ? data.updatedAt : 0
      };
    }).catch(function () { return null; });      /* 取得失敗時はフレンドに触らない */
    return Promise.all([savesP, friendsP]).then(function (res) {
      merging = false;
      if (!me || me.uid !== uid || !syncMeta || syncMeta.owner !== uid) return false;   /* 途中でログアウト/引き継ぎした */
      if (gen !== syncGen) return false;   /* 途中で初期化/引き継ぎがあった。古い取得結果で上書きしない */
      applyCloudMerge(uid, res[0]);
      if (res[1]) applyFriendsMerge(res[1]);
      mergedUid = uid;
      setStatus('クラウドセーブ有効');
      publishProfileExtras();
      flushUploads();
      uploadFriends();   /* ローカルの方が新しいフレンド一覧があれば上げる（ハッシュ一致なら無動作） */
      return true;
    }).catch(function () {
      merging = false;
      /* ローカルだけで完結する。次回の syncNow / フォーカス復帰で再試行する */
      if (me && me.uid === uid) setStatus('クラウドと同期できませんでした（この端末のデータで遊べます）');
      return false;
    });
  }
  /* マージの実適用（ローカル状態は適用時点のものを読む）。
     ローカル勝ちのキーは dirtyKeys に入れてこの後の flushUploads で上げる */
  function applyCloudMerge(uid, cloud) {
    if (!syncMeta) syncMeta = loadMeta();
    var meta = syncMeta;
    var localKeys = {};
    storeKeys().forEach(function (k) { if (syncableKey(k)) localKeys[k] = true; });
    var all = {};
    Object.keys(localKeys).forEach(function (k) { all[k] = true; });
    Object.keys(cloud).forEach(function (k) { if (syncableKey(k)) all[k] = true; });
    Object.keys(meta.del).forEach(function (k) { if (syncableKey(k)) all[k] = true; });
    Object.keys(all).forEach(function (k) {
      var c = cloud[k];
      var hasLocal = !!localKeys[k];
      var localTs = (typeof meta.keys[k] === 'number') ? meta.keys[k] : null;
      var delTs = (typeof meta.del[k] === 'number') ? meta.del[k] : null;
      if (hasLocal && localTs === null && delTs === null) {
        /* メタに記録が無いローカル値（ゲスト期の書き込み・メタ喪失時など）:
           クラウドに在ればクラウドを正とし、無ければこの端末の値を
           初版として上げる。ただし updatedAt を持たないクラウド文書
           （ts=0）は「新しい」根拠が無いため、値・削除のどちらでも
           ローカルを上書きしない（ローカルを初版として上げ、文書の
           時刻も修復する） */
        if (c && c.ts > 0 && !c.del) {
          diskSet(k, c.v); meta.keys[k] = c.ts; delete meta.del[k];
        } else if (c && c.ts > 0 && c.del) {
          diskRemove(k); delete meta.keys[k]; meta.del[k] = c.ts;
        } else {
          meta.keys[k] = nowMs(); dirtyKeys[k] = true;
        }
        return;
      }
      /* 候補: ローカル値 @localTs / ローカル削除 @delTs / クラウド @c.ts。
         同点はローカル優先（自分の直近の書き込みを守る） */
      var winTs = -1, win = null;
      if (hasLocal && localTs !== null) { winTs = localTs; win = 'local'; }
      if (delTs !== null && delTs > winTs) { winTs = delTs; win = 'del'; }
      if (c && c.ts > winTs) { winTs = c.ts; win = c.del ? 'cdel' : 'cloud'; }
      if (win === 'cloud') {
        diskSet(k, c.v); meta.keys[k] = c.ts; delete meta.del[k];
      } else if (win === 'cdel') {
        if (hasLocal) diskRemove(k);
        delete meta.keys[k]; meta.del[k] = c.ts;
      } else if (win === 'local') {
        if (!c || c.del || c.ts < localTs || c.v !== diskGet(k)) dirtyKeys[k] = true;
      } else if (win === 'del') {
        if (c && !c.del) dirtyKeys[k] = true;   /* クラウド側の文書を消す */
      }
    });
    persistMeta();
  }
  /* フレンド一覧のマージ（版はメタの friendsTs と文書の updatedAt で比較） */
  function applyFriendsMerge(f) {
    var localTs = syncMeta ? syncMeta.friendsTs : 0;
    if (friendsLocalDirty || localTs > f.ts) {
      /* ローカルの方が新しい（または未送信の変更がある）→ 触らない。
         この後の uploadFriends() がクラウドへ上げる */
      return;
    }
    var list = f.list || [];
    if (friendsListHash(list) !== friendsListHash(localFriends())) {
      applyFriendsToLocal(list);
    }
    if (syncMeta) { syncMeta.friendsTs = f.ts; persistMeta(); }
    refreshPresenceWatch();
  }

  /* ---------------- セーブデータ初期化（v66〜・v74 で端末ストアも対象に） ----
     自分のクラウドセーブ全削除＋この端末ストアの同期対象キー・フレンド
     全消去＋同期メタ初期化（owner 解除）＋公開戦績のリセット。
     白紙へ戻すための機能で、他人のクラウドには一切触らない。 */
  function resetMyData() {
    if (!me || !fb) return Promise.resolve({ ok: false, msg: 'ログインが必要です' });
    var uid = me.uid;
    /* 進行中のマージの適用を無効化し、送信中のアップロードが落ち着いてから
       クラウドを消す（消した直後に古いマージ/送信がデータを蘇らせるのを防ぐ） */
    syncGen++;
    resettingUid = uid;
    return uploadsSettled().then(function () {
      return savesCol(uid).get();
    }).then(function (snap) {
      var jobs = [];
      snap.forEach(function (d) {
        try { jobs.push(saveDoc(uid, decodeURIComponent(d.id)).delete()); } catch (e) {}
      });
      return Promise.all(jobs);
    }).then(function () {
      return userDoc(uid).set({ stats: {}, mainChar: '' }, { merge: true });
    }).then(function () {
      /* この端末側も消す: 端末ストアの同期対象キーとフレンドを全消去し、
         同期メタを初期化して owner を解除する（次にログインする人が
         誰であれ、まっさらな端末として扱われる） */
      wipeDeviceStore(null);
      syncMeta = blankMeta();
      persistMeta();
      storeOwner = null;
      dirtyKeys = {};
      friendsLocalDirty = false;
      lastFriendsHash = friendsListHash([]);
      mergedUid = uid;   /* ローカル・クラウドとも空で一致しているので同期済み扱い */
      resettingUid = null;
      lastExtrasJson = '';
      myProfile.stats = {};
      myProfile.mainChar = '';
      return { ok: true };
    }).catch(function (e) {
      resettingUid = null;
      return { ok: false, msg: '初期化に失敗しました' + (e && e.code ? '（' + e.code + '）' : '') };
    });
  }

  /* ---------------- バックアップから復元 ----------------
     ポータルで書き出したバックアップ JSON を、ログイン中アカウントの
     セーブへ取り込む。対応形式:
       - ポータル形式 {app, version, exportedAt, data:{key: 文字列値}}
       - 旧退避形式   {savedAt, data:{key: 文字列値}}
       - 素の key→値マップ {key: 文字列値}
     取り込みは通常の保存経路（シム経由の書き込み→素キー→クラウド同期）に
     乗せる。直接 Firestore は叩かない。素キーへの書き込みは即時に端末へ
     永続化され、取り込んだ値には最新の updatedAt が付くため、その後の
     マージでもクラウドの古い値に負けない。フレンド一覧
     （playweb_friends）だけはフレンド経路で送る。対象外キーと文字列でない
     値は取り込まず、件数だけ数えて結果に含める。 */
  var RESTORE_EXCLUDE = {
    playweb_chats: true,          /* チャットは v55 で廃止済み */
    playweb_unread: true,         /* 同上（未読管理も廃止済み） */
    playweb_fabpos: true          /* 旧 FAB の位置（v51 で FAB 廃止済み） */
  };
  function parseBackup(input) {
    var parsed = input;
    if (typeof input === 'string') {
      try { parsed = JSON.parse(input); }
      catch (e) { return { ok: false, msg: 'バックアップファイルを読み取れませんでした（JSON形式ではありません）' }; }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, msg: 'バックアップの形式が正しくありません' };
    }
    var data = null, exportedAt = '';
    if ('data' in parsed && (!parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data))) {
      /* data を名乗りながら中身が壊れているものは、素マップとして
         誤って取り込まず形式エラーにする */
      return { ok: false, msg: 'バックアップの形式が正しくありません' };
    }
    if (parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)) {
      data = parsed.data;
      exportedAt = String(parsed.exportedAt || parsed.savedAt || '');
    } else {
      /* 素の key→値マップ。コンテナのメタキーはデータとして取り込まない */
      data = {};
      exportedAt = String(parsed.exportedAt || parsed.savedAt || '');
      Object.keys(parsed).forEach(function (k) {
        if (k === 'app' || k === 'version' || k === 'exportedAt' || k === 'savedAt') return;
        data[k] = parsed[k];
      });
    }
    var total = Object.keys(data).length;
    if (!total) return { ok: false, msg: 'バックアップにデータが含まれていません' };
    return { ok: true, data: data, exportedAt: exportedAt, total: total };
  }
  function restoreFromBackup(input) {
    /* 実行条件: ログイン中のみ。それ以外は何も書き込まず、案内だけを返す
       （誤ってゲストの状態へ書き込む事故を防ぐ）。クラウドとのマージ完了は
       条件にしない: 主保存は端末側であり、取り込みは即永続化されるため、
       マージ前でも安全に取り込める（取り込んだ値は最新の版としてマージに勝つ） */
    if (!me || !fb) {
      setStatus('データの読み込み完了後に実行してください');
      return { ok: false, msg: 'データの読み込み完了後に実行してください' };
    }
    if (input && typeof input === 'object' && input.ok === false) {
      setStatus(input.msg || 'バックアップの形式が正しくありません');
      return { ok: false, msg: input.msg || 'バックアップの形式が正しくありません' };
    }
    var info = parseBackup(input);
    if (!info.ok) { setStatus(info.msg); return { ok: false, msg: info.msg }; }
    var applied = 0, skipped = 0, excluded = 0, friendsApplied = false;
    Object.keys(info.data).forEach(function (k) {
      var v = info.data[k];
      if (typeof v !== 'string') { skipped++; return; }   /* 文字列でない値は対象外 */
      if (k === 'playweb_friends') {
        /* フレンドは専用経路: シム経由でメモリへ入れると送信フラグが立ち、
           uploadFriends がクラウドのフレンド文書へ書き戻す */
        try { localStorage.setItem('playweb_friends', v); friendsApplied = true; } catch (e) {}
        return;
      }
      if (RESTORE_EXCLUDE[k] || !syncableKey(k)) { excluded++; return; }
      try { localStorage.setItem(k, v); applied++; } catch (e) {}
    });
    /* 端末には既に永続化されている。あとはクラウド同期を進める:
       マージ未完了なら開始し、送信待ちを流す。settled は「クラウドへの
       同期まで確認できたか」を返す（未確認でも端末には保存済みで、
       次回接続時のマージ・再送で必ず同期される） */
    if (mergedUid !== me.uid) mergeCloudSaves();
    var settled = flushUploads();
    if (friendsApplied) uploadFriends();
    var msg = 'バックアップから復元しました（セーブ' + applied + '件' +
      (friendsApplied ? '・フレンド' : '') + '）';
    setStatus('復元したセーブをクラウドへ同期しています…');
    var result = {
      ok: true, applied: applied, friends: friendsApplied,
      skipped: skipped, excluded: excluded, exportedAt: info.exportedAt, msg: msg
    };
    result.settled = settled.then(function (r) {
      if (r.ok) {
        setStatus(msg);
        return {
          ok: true, applied: applied, friends: friendsApplied, confirmed: true,
          skipped: skipped, excluded: excluded, exportedAt: info.exportedAt, msg: msg
        };
      }
      setStatus('この端末に保存済みです（クラウド同期は保留中）');
      return {
        ok: true, applied: applied, friends: friendsApplied, confirmed: false,
        skipped: skipped, excluded: excluded, exportedAt: info.exportedAt,
        msg: msg + '\n（この端末には保存済みです。クラウドへは接続でき次第同期されます）'
      };
    });
    return result;
  }

  /* ---------------- バックアップを書き出し（v73〜復活） ----------------
     現在の端末ストア（＝ログイン中アカウントの端末内セーブ）を、復元側
     （parseBackup / restoreFromBackup）がそのまま読める形式で JSON
     ファイルとしてダウンロードさせる:
       { app:'playweb-backup', version:1, exportedAt, data:{key:値} }
     ログイン中の時だけ有効。戻り値は書き出したペイロードそのもの
     （テストや呼び出し側の検証用）。ダウンロードの仕組み（Blob / URL）が
     無い環境ではペイロードを返すだけにする */
  function exportBackup() {
    if (!me) {
      setStatus('ログイン後に書き出せます');
      return { ok: false, msg: 'ログイン後に書き出せます' };
    }
    var payload = {
      app: 'playweb-backup', version: 1,
      exportedAt: new Date().toISOString(),
      data: storeSnapshot()
    };
    try {
      if (typeof Blob !== 'undefined' && typeof URL !== 'undefined' && URL && typeof URL.createObjectURL === 'function') {
        var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'playweb-backup-' + payload.exportedAt.slice(0, 10) + '.json';
        if (document.body && document.body.appendChild) document.body.appendChild(a);
        if (a && typeof a.click === 'function') a.click();
        if (typeof setTimeout === 'function') {
          setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 4000);
        }
      }
    } catch (e) {}
    return payload;
  }

  /* ---------------- localStorage の保存シム（v74〜 素通し＋書き込みフック） ----
     Storage.prototype を差し替えるが、読み書き自体は（firebase: で始まる
     認証キーを含め）全て実ディスクの素キーへ素通しする。シムの仕事は
     書き込みフックだけ: 同期メタの版上げ、クラウド送信予約、戦績 publish
     予約などの副作用を、値がディスクへ書かれた後に行う。
     振り替えをしないため、認証状態やタイミングに左右されず、書いた値は
     その場で端末に残り、次のページでそのまま読める。
     clear() だけは例外で、端末ストアのゲーム系キーだけを対象にする
     （Firebase Auth のキーや同期メタまで消すと認証・同期が壊れるため）。
     sessionStorage には干渉しない。 */
  function onLocalWrite(key, value) {
    /* 戦績・リンクサーガのセーブが変わったらプロフィール集計の再 publish を予約 */
    if (key === 'playweb_records' || key === 'linksaga_save_v1') schedulePublishExtras();
    if (key === 'playweb_friends') {
      if (!applyingFriends) {
        friendsLocalDirty = true;
        if (me && syncMeta) { syncMeta.friendsTs = nowMs(); persistMeta(); }
      }
      scheduleFriendsUpload();
      return;
    }
    if (!me) {
      /* 未ログインでも、端末ストアに所有者がいる場合は「所有者の端末での
         書き込み」として版だけは記録する。認証確定前（ページ読み込み直後、
         ゲームの初期化やオートセーブが認証復元より先に走る）やログアウト中
         の書き込みは実際に一番新しいのに、版を上げないと次回マージで
         古い版のまま扱われ、別端末で少し進んだだけのクラウド値に LWW で
         負けて実データが消えるため。送信予約はしない（上げるのは所有者が
         次にログインした時のマージが、版と値の比較から自動で行う）。
         所有者がいない端末（ゲスト専用端末）では従来どおり触らない:
         初回ログイン時にクラウドを正とする設計を守る */
      if (syncMeta && syncMeta.owner) metaTouch(key, nowMs());
      return;
    }
    metaTouch(key, nowMs());
    markDirty(key);
  }
  function onLocalRemove(key) {
    if (key === 'playweb_friends') {
      if (!applyingFriends) {
        friendsLocalDirty = true;
        if (me && syncMeta) { syncMeta.friendsTs = nowMs(); persistMeta(); }
      }
      scheduleFriendsUpload();
      return;
    }
    if (!me) {
      /* 書き込みと同じ理由で、所有者がいる端末での未ログイン削除も版を残す */
      if (syncMeta && syncMeta.owner) metaDelete(key, nowMs());
      return;
    }
    metaDelete(key, nowMs());
    markDirty(key);
  }
  (function patchStorage() {
    try {
      var proto = window.Storage && Storage.prototype;
      if (!proto || proto.__pwAcctPatched) return;
      var origGet = proto.getItem, origSet = proto.setItem,
          origRemove = proto.removeItem, origClear = proto.clear;
      proto.getItem = function (k) {
        return origGet.apply(this, arguments);   /* 素通し */
      };
      proto.setItem = function (k, v) {
        var r = origSet.apply(this, arguments);   /* まず実ディスクへ書く */
        if (this === window.localStorage && !shimExempt(String(k))) {
          try { onLocalWrite(String(k), String(v)); } catch (e) {}
        }
        return r;
      };
      proto.removeItem = function (k) {
        var existed = false;
        if (this === window.localStorage && !shimExempt(String(k))) {
          try { existed = origGet.call(this, String(k)) !== null; } catch (e) {}
        }
        var r = origRemove.apply(this, arguments);
        if (existed) {
          try { onLocalRemove(String(k)); } catch (e) {}
        }
        return r;
      };
      proto.clear = function () {
        if (this === window.localStorage) {
          /* 端末ストアのゲーム系キーだけを空にする（Firebase Auth のキーと
             同期メタには触らない） */
          var keys = storeKeys();
          keys.forEach(function (k) { diskRemove(k); });
          keys.forEach(function (k) { try { onLocalRemove(k); } catch (e) {} });
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
  /* フレンド一覧は users/{uid}/data/friends と同期する。競合解決はセーブと
     同じ「新しい方の勝ち」で、版はメタの friendsTs と文書の updatedAt を
     比較する（マージ: applyFriendsMerge／購読: startServices 内）。
     ローカル側の変更（追加/削除）は friends.js 経由で端末ストアへ入り、
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
    if (mergedUid !== me.uid) return; /* マージ前はクラウドと未比較（古いローカルで上書きしない） */
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

  /* ---------------- 招待（Firestore） ----------------
     invites コレクションにはゲーム招待（kind なし）とフレンド申請
     （kind:'friend'）が同居する。双方の処理で kind を見て確実に振り分ける
     （フレンド申請をゲーム招待として拾わない／その逆もしない）。 */
  var seenInviteIds = {};
  function startInviteListener() {
    var q = fb.db.collection('invites').where('toUid', '==', me.uid);
    var unsub = q.onSnapshot(function (snap) {
      var newReqIn = {};
      snap.forEach(function (d) {
        var inv = d.data() || {};
        if (inv.kind === 'friend') {
          /* フレンド申請は申請セクション側で扱う（下のフレンド申請節）。
             pending のものだけを受信リストに集める */
          if (inv.status === 'pending' && inv.fromUid) {
            if (friendEntryByUid(inv.fromUid)) {
              /* 既にフレンドの相手からの古い申請は静かに掃除する */
              fb.db.doc('invites/' + d.id).delete().catch(function () {});
            } else {
              newReqIn[d.id] = {
                fromUid: inv.fromUid, fromName: inv.fromName || '',
                createdAt: inv.createdAt || 0
              };
            }
          }
          return;
        }
        if (inv.status !== 'pending') return;
        if (seenInviteIds[d.id]) return;
        if (nowMs() - (inv.ts || 0) > INVITE_TTL_MS) {
          seenInviteIds[d.id] = true;
          fb.db.doc('invites/' + d.id).set({ status: 'expired' }, { merge: true }).catch(function () {});
          return;
        }
        var api = pwf();
        if (!api || !api._cloud || typeof api._cloud.receiveInvite !== 'function') {
          /* friends.js がまだ読み込まれていない: ここで delivered にして
             しまうと招待が静かに消える。pending のまま残し、次回の
             スナップショット（または次のセッション）で再配送する */
          return;
        }
        var accepted = api._cloud.receiveInvite({
          from: inv.fromUid, name: inv.fromName || '', game: inv.game,
          room: inv.room, cloudId: d.id
        });
        if (!accepted) return; /* 不正な招待（未知のゲーム等）は delivered にしない */
        seenInviteIds[d.id] = true;
        fb.db.doc('invites/' + d.id).set({ status: 'delivered' }, { merge: true }).catch(function () {});
      });
      friendReqIn = newReqIn;
      pushFriendReqUI();
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
      }).then(function (ref) { return (ref && ref.id) ? ref.id : true; });
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
  /* 送信側の招待取り消し: 自分が送った招待ドキュメントを削除する
     （ルール上、送信者も当事者として削除できる）。相手の画面に既に
     表示されている分は、相手側の表示有効期限（friends.js 側で10分）
     で自然に消える */
  function withdrawInviteCloud(id) {
    if (!fb || !id) return Promise.resolve(false);
    return fb.db.doc('invites/' + id).delete()
      .then(function () { return true; }).catch(function () { return false; });
  }

  /* ---------------- チャット（v55 で機能削除） ----------------
     1対1チャットはユーザーの判断で廃止した。Firestore の messages
     コレクションはもう購読も送信もしない（ルール側は変更していない）。
     旧 pwacct_meta に残っていた chatSeen 等も v66 でメタごと全廃した。 */

  /* ---------------- ユーザー名検索・フレンド申請 ----------------
     フレンド追加は「検索 → 申請 → 相手が承認して初めてフレンド」の申請制。
     申請は invites コレクションに kind:'friend' のドキュメントとして作る
     （現行ルールで当事者だけが読み書きできる）。
       { kind:'friend', fromUid, toUid, fromName, toName,
         status:'pending'|'accepted', createdAt }
     承認した側はその場で相手をフレンド一覧に加える。申請した側は自分の
     送信分購読で status=='accepted' を検知して相手を加え、ドキュメントを
     削除して消費する（consumed 化）。断る時はドキュメントを削除する
     （申請者側の「申請中」表示が消えるだけで、断られた旨は表示しない）。 */
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
        return {
          uid: uid, username: data.username || v.name,
          iconId: data.iconId || '', iconColor: data.iconColor || '',
          comment: data.comment || '', online: !!data.online,
          lastSeen: data.lastSeen || 0
        };
      });
    }).catch(function () { return null; });
  }
  function friendEntryByUid(uid) {
    var list = localFriends();
    for (var i = 0; i < list.length; i++) if (list[i].uid === uid) return list[i];
    return null;
  }
  /* フレンド一覧へ1件追加する共通経路（重複は無視）。
     friends.js の _cloud.addFriend 経由で端末ストアへ入れ、クラウド同期と
     プレゼンス購読に乗せる */
  function addFriendEntry(entry) {
    if (!entry || !entry.uid) return false;
    if (friendEntryByUid(entry.uid)) return false;
    var api = pwf();
    if (api && api._cloud && api._cloud.addFriend) api._cloud.addFriend(entry);
    else {
      var list = localFriends();
      list.push(entry);
      try { localStorage.setItem('playweb_friends', JSON.stringify(list)); } catch (e) {}
    }
    refreshPresenceWatch();
    return true;
  }

  /* フレンド申請の状態（購読で再構築される）
     friendReqIn:  id -> {fromUid, fromName, createdAt}（自分宛・pending のみ）
     friendReqOut: id -> {toUid, toName, status}（自分の送信分） */
  var friendReqIn = {};
  var friendReqOut = {};
  var friendReqConsuming = {}; /* accepted 消費処理中の送信ドキュメント id */

  function friendStateFor(uid) {
    if (!uid) return 'none';
    if (me && uid === me.uid) return 'self';
    if (friendEntryByUid(uid)) return 'friend';
    var ids = Object.keys(friendReqOut);
    for (var i = 0; i < ids.length; i++) {
      if (friendReqOut[ids[i]].toUid === uid && friendReqOut[ids[i]].status === 'pending') return 'outgoing';
    }
    var iids = Object.keys(friendReqIn);
    for (var j = 0; j < iids.length; j++) {
      if (friendReqIn[iids[j]].fromUid === uid) return 'incoming';
    }
    return 'none';
  }
  function friendReqInList() {
    return Object.keys(friendReqIn).map(function (id) {
      var r = friendReqIn[id];
      return { id: id, fromUid: r.fromUid, fromName: r.fromName, createdAt: r.createdAt };
    }).sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
  }
  /* 受信申請リストを friends.js（フレンド欄の申請セクション＋バッジ）へ渡す */
  function pushFriendReqUI() {
    var api = pwf();
    if (api && api._cloud && api._cloud.setFriendRequests) {
      try { api._cloud.setFriendRequests(friendReqInList()); } catch (e) {}
    }
  }
  function sendFriendRequest(username) {
    if (!cloudActive()) return Promise.resolve({ ok: false, msg: 'ログインが必要です' });
    var v = validateUsername(username);
    if (!v.ok) return Promise.resolve({ ok: false, msg: v.error });
    if (v.name.toLowerCase() === me.usernameLower) return Promise.resolve({ ok: false, msg: 'それはあなた自身のユーザー名です' });
    return searchUser(v.name).then(function (found) {
      if (!found) return { ok: false, msg: 'そのユーザー名の人は見つかりませんでした' };
      var st = friendStateFor(found.uid);
      if (st === 'friend') return { ok: false, msg: 'すでにフレンドです', user: found };
      if (st === 'outgoing') return { ok: false, msg: 'すでに申請中です', user: found };
      if (st === 'incoming') return { ok: false, msg: 'この人から申請が届いています。下の「フレンド申請が届いています」で承認できます', user: found };
      return fb.db.collection('invites').add({
        kind: 'friend', fromUid: me.uid, toUid: found.uid,
        fromName: me.username, toName: found.username,
        status: 'pending', createdAt: nowMs()
      }).then(function (ref) {
        /* 購読が届く前に「申請中」表示へ切り替えられるよう楽観的に記録する */
        if (ref && ref.id) friendReqOut[ref.id] = { toUid: found.uid, toName: found.username, status: 'pending' };
        return { ok: true, msg: found.username + 'さんにフレンド申請を送りました', user: found };
      }).catch(function () {
        return { ok: false, msg: '申請を送れませんでした（通信環境を確認してください）', user: found };
      });
    });
  }
  function cancelFriendRequest(toUid) {
    if (!cloudActive() || !toUid) return Promise.resolve(false);
    var ids = Object.keys(friendReqOut);
    for (var i = 0; i < ids.length; i++) {
      var r = friendReqOut[ids[i]];
      if (r.toUid === toUid && r.status === 'pending') {
        var id = ids[i];
        delete friendReqOut[id];
        return fb.db.doc('invites/' + id).delete()
          .then(function () { return true; }).catch(function () { return false; });
      }
    }
    return Promise.resolve(false);
  }
  function respondFriendRequest(id, accept) {
    if (!cloudActive() || !id) return Promise.resolve(false);
    var req = friendReqIn[id];
    if (!req) return Promise.resolve(false);
    var ref = fb.db.doc('invites/' + id);
    if (!accept) {
      delete friendReqIn[id];
      pushFriendReqUI();
      return ref.delete().then(function () { return true; }).catch(function () { return false; });
    }
    return ref.set({ status: 'accepted' }, { merge: true }).then(function () {
      addFriendEntry({ uid: req.fromUid, username: req.fromName, addedAt: nowMs() });
      delete friendReqIn[id];
      pushFriendReqUI();
      return true;
    }).catch(function () { return false; });
  }
  /* 自分の送信分の購読: accepted を検知してフレンド化＋ドキュメント消費 */
  function startFriendReqOutListener() {
    var q = fb.db.collection('invites').where('fromUid', '==', me.uid);
    var unsub = q.onSnapshot(function (snap) {
      var next = {};
      snap.forEach(function (d) {
        var inv = d.data() || {};
        if (inv.kind !== 'friend' || !inv.toUid) return;
        next[d.id] = { toUid: inv.toUid, toName: inv.toName || '', status: inv.status || 'pending' };
      });
      friendReqOut = next;
      Object.keys(next).forEach(function (id) {
        var r = next[id];
        if (r.status !== 'accepted' || friendReqConsuming[id]) return;
        friendReqConsuming[id] = true;
        var already = !!friendEntryByUid(r.toUid);
        if (!already) {
          addFriendEntry({ uid: r.toUid, username: r.toName, addedAt: nowMs() });
          var api = pwf();
          if (api && api._cloud && api._cloud.toast) {
            try { api._cloud.toast('👥 ' + (r.toName || 'フレンド') + 'さんがフレンド申請を承認しました', 'info'); } catch (e) {}
          }
        }
        fb.db.doc('invites/' + id).delete().catch(function () {})
          .then(function () { delete friendReqConsuming[id]; });
      });
    }, function () {});
    unsubs.push(unsub);
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
  function ensureProfileDocs(uid, username, isNew) {
    var lower = username.toLowerCase();
    var profile = {
      username: username, usernameLower: lower,
      online: true, lastSeen: nowMs(), currentGame: MY_GAME
    };
    /* 作成日時は新規登録の時だけ記録する（ログインのたびの merge では
       触らない＝一度記録された値を上書きしない） */
    if (isNew) profile.createdAt = nowMs();
    return Promise.all([
      userDoc(uid).set(profile, { merge: true }),
      claimUsername(uid, lower)
    ]);
  }
  function heartbeat() {
    if (!cloudActive()) return;
    /* 非表示タブでは書き込まない。隠れた直後は setOffline() が online:false を
       書くのに、止まらないタイマーが online:true を書き戻し続ける穴があった。
       表示に戻った時は visibilitychange 側の即時ハートビートで立て直す */
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
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
  /* アカウント作成日時の保存形式ゆらぎを ms 数値へ正規化する。
     数値（nowMs 形式）→そのまま / Timestamp（toMillis、または
     seconds+nanoseconds）→変換 / 文字列→Date.parse。解釈不能は null */
  function createdAtToMs(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (typeof v === 'string') { var p = Date.parse(v); return isNaN(p) ? null : p; }
    if (typeof v === 'object') {
      if (typeof v.toMillis === 'function') {
        try { var m = v.toMillis(); return (typeof m === 'number' && isFinite(m)) ? m : null; } catch (e) { return null; }
      }
      if (typeof v.seconds === 'number' && isFinite(v.seconds)) {
        return v.seconds * 1000 + Math.floor((typeof v.nanoseconds === 'number' ? v.nanoseconds : 0) / 1e6);
      }
    }
    return null;
  }
  /* Auth 側の作成記録（user.metadata.creationTime）で作成日時を補う。
     プロフィール文書に createdAt が無いアカウント（過去の登録分は全て
     該当する）でも作成日時を返せるようにするフォールバック。
     文書側の値が取れている場合はそちらを優先し、上書きしない */
  function noteAuthCreation(user) {
    if (myCreatedAtMs !== null) return;
    var ms = createdAtToMs(user && user.metadata ? user.metadata.creationTime : null);
    if (ms !== null) myCreatedAtMs = ms;
  }
  /* プロフィール文書の拡張フィールドを myProfile へ取り込む */
  function absorbProfileData(data) {
    if (!data) return;
    if (typeof data.iconId === 'string') myProfile.iconId = data.iconId;
    if (typeof data.iconColor === 'string') myProfile.iconColor = data.iconColor;
    if (typeof data.comment === 'string') myProfile.comment = data.comment;
    if (data.stats && typeof data.stats === 'object') myProfile.stats = data.stats;
    if (typeof data.mainChar === 'string') myProfile.mainChar = data.mainChar;
    var ca = createdAtToMs(data.createdAt);
    if (ca !== null) myCreatedAtMs = ca;
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
    /* セーブとフレンド一覧をクラウドとマージする
       （マージ完了時に戦績集計の publish まで行う） */
    mergeCloudSaves();
    startAdminInbox();
    /* フレンド一覧の購読: クラウドの方が新しい時だけ取り込む
       （ローカルの方が新しい場合は uploadFriends 側が上げる） */
    var fu = friendsDoc(me.uid).onSnapshot(function (d) {
      if (!d.exists) return;
      if (friendsLocalDirty) return; /* ローカルの未送信変更を守る（送信側が勝つ） */
      var cloudTs = (d.data() && typeof d.data().updatedAt === 'number') ? d.data().updatedAt : 0;
      if (syncMeta && syncMeta.friendsTs > cloudTs) return; /* ローカルの方が新しい */
      var cloudList = (d.data() && Array.isArray(d.data().list)) ? d.data().list : [];
      if (friendsListHash(cloudList) === lastFriendsHash) return;
      applyFriendsToLocal(cloudList);
      if (syncMeta && cloudTs > syncMeta.friendsTs) { syncMeta.friendsTs = cloudTs; persistMeta(); }
      refreshPresenceWatch();
    }, function () {});
    unsubs.push(fu);
    startInviteListener();
    startFriendReqOutListener();
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
    closeProfile();
    friendReqIn = {}; friendReqOut = {};
    pushFriendReqUI();
    updatePill(); updateModal(); updateSearchRow();
  }
  var lastPullAt = 0;
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      /* タブが隠れたら即オフライン化（フレンド側にすぐ伝わる） */
      if (cloudActive()) setOffline();
      return;
    }
    /* 戻ってきたら即ハートビートでオンライン復帰＋必要ならクラウドと再マージ */
    if (cloudActive()) heartbeat();
    if (document.visibilityState === 'visible' && cloudActive() && nowMs() - lastPullAt > 30000) {
      lastPullAt = nowMs();
      mergeCloudSaves({ force: true });
    }
  });
  window.addEventListener('beforeunload', function () {
    /* ローカルへの書き込みは同期的に完了しているため、離脱時にやることは
       クラウド送信の促しだけ（ベストエフォート） */
    flushUploads();
    if (cloudActive()) setOffline();
  });
  window.addEventListener('pagehide', function () {
    flushUploads();
    if (cloudActive()) setOffline();
  });

  /* ---------------- 認証アクション ---------------- */
  /* 登録・ログインの最中は onAuthUser 側の自動処理を抑え、ハンドラ側で
     onAuthUser を明示的に駆動する（再読み込みはしない）。所有者の引き継ぎ
     自体は onAuthUser の冒頭で一元的に行う（activateStoreForUser） */
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
    /* ログイン中の別ユーザーがいる場合は、先にその人の未送信分を本人の
       クラウドへ上げてから認証を切り替える（所有者引き継ぎの消去で
       未送信分まで消えないようにするため） */
    return flushBeforeAuthChange().then(function () {
    pendingUsername = name;
    authTransition = 'signup';
    return fb.auth.createUserWithEmailAndPassword(usernameToEmail(name), password).then(function (cred) {
      var uid = cred.user.uid;
      return ensureProfileDocs(uid, name, true).then(function () {
        pendingUsername = null;
        /* 端末ストアの扱いは onAuthUser 冒頭の所有者引き継ぎが決める:
           端末の owner が他人なら全消去して空から始まり、未設定なら
           そのまま自分のものになる。他アカウントのクラウドへ触れる
           旧方式の「初回移行アップロード」はしない。そのまま onAuthUser を
           駆動してマージ（自分のクラウドとの LWW）を開始する */
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
    });
  }
  function doLogin(username, password) {
    var v = validateUsername(username);
    if (!v.ok) return Promise.resolve({ ok: false, msg: v.error });
    if (!fb) return Promise.resolve({ ok: false, msg: 'ログイン機能を読み込めませんでした' });
    /* ログイン中の別ユーザーがいる場合は、先にその人の未送信分を本人の
       クラウドへ上げてから認証を切り替える（doSignup と同じ引き継ぎ対策） */
    return flushBeforeAuthChange().then(function () {
    authTransition = 'login';
    return fb.auth.signInWithEmailAndPassword(usernameToEmail(v.name), password)
      .then(function (cred) {
        /* 端末ストアの扱いは onAuthUser 冒頭の所有者引き継ぎが決める
           （owner が他人なら入れ替わり、自分/未設定ならそのまま）。
           そのまま onAuthUser を駆動し、このアカウントのローカル＋
           クラウドとマージする */
        authTransition = null;
        if (cred && cred.user) onAuthUser(cred.user);
        return { ok: true, msg: 'ログインしました' };
      })
      .catch(function (e) {
        authTransition = null;
        return { ok: false, msg: authErrorMessage(e) };
      });
    });
  }
  function doLogout() {
    if (!fb) return Promise.resolve();
    /* 先に未送信分を本人のクラウドへ上げ切る（デバウンス待ちの書き込みが
       ログアウトで宙に浮き、その後の引き継ぎで消えるのを防ぐ）。
       端末ストアと owner は従来どおり消さない */
    return flushBeforeAuthChange().then(function () {
    setOffline();
    stopServices();
    me = null;
    myCreatedAtMs = null;
    mergedUid = null;
    /* ログアウトでは端末ストアも owner も消さない。データは端末とクラウドに
       残り、次回同じアカウントのログインが無摩擦になる（別のアカウントが
       ログインした時点で所有者引き継ぎにより入れ替わる） */
    setGate('guest');
    updatePill(); updateModal(); updateSearchRow();
    return fb.auth.signOut().catch(function () {});
    });
  }
  function onAuthUser(user) {
    if (!user) {
      /* ログアウト/セッション切れ: ゲスト化する。端末ストアと owner は
         そのまま残す（次回ログイン時に引き継ぎ判定が働く） */
      if (me) { stopServices(); me = null; }
      myCreatedAtMs = null;
      mergedUid = null;
      setGate(sdkState === 'unavailable' ? 'sdk-down' : 'guest');
      updatePill(); updateModal(); updateSearchRow();
      return;
    }
    /* 陳腐化した認証イベントのガード: 名前確保に失敗して認証ユーザーを
       巻き戻した直後など、既にサインアウト済みのユーザーに対する遅延イベントが
       届くことがある。現在のセッションが無いならそのイベントは無視する
       （ゲスト扱いのままにする） */
    if (fb && fb.auth && !fb.auth.currentUser) return;
    /* 端末ストアの所有者は認証の確定に合わせてここで一元的に合わせる
       （救済インポート＋必要なら引き継ぎ） */
    activateStoreForUser(user.uid);
    if (authTransition) {
      /* 登録・ログインのハンドラが再駆動を担当する。ここではサービスを
         開始しない（マージ前の状態で同期が走るのを防ぐ） */
      var tname = pendingUsername || (user.email || '').split('@')[0] || 'player';
      me = { uid: user.uid, username: tname, usernameLower: tname.toLowerCase() };
      setGate('member');
      updatePill(); updateModal(); updateSearchRow();
      return;
    }
    if (me && me.uid === user.uid && servicesOn) { setGate('member'); return; }
    if (me && me.uid !== user.uid) {
      /* アカウント切替: 前のアカウントのサービスを止める
         （端末ストアの所有者は上で合わせ済み） */
      stopServices();
      me = null;
      myCreatedAtMs = null;
    }
    var uid = user.uid;
    userDoc(uid).get().then(function (d) {
      absorbProfileData(d.exists ? d.data() : null);
      noteAuthCreation(user);
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
      noteAuthCreation(user);
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
    rpg: 'モンスターライズ', otome: '乙女ゲーム', linksaga: 'スターリンクサーガ',
    reaction: 'はんしゃテスト', mash: 'れんだバトル', numguess: 'かずあて',
    janken: 'じゃんけんバトル', calc: 'けいさんダッシュ', memory: 'しんけいすいじゃく',
    mole: 'もぐらパニック', simon: 'いろメモリ', timing: 'タイミングストップ',
    dice: 'ダイスレース', taiko: 'リンクドラムサーガ', snake: 'スネークアリーナ',
    starrhythm: 'スターリズム'
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
    '#pwDrawerWrap{position:fixed;inset:0;z-index:100006;pointer-events:none;visibility:hidden;transition:visibility 0s linear .4s;font-family:"Hiragino Kaku Gothic ProN","Noto Sans JP",system-ui,sans-serif}',
    '#pwDrawerWrap.open{visibility:visible;transition-delay:0s}',
    /* 閉じている間は visibility:hidden でヒットテスト自体を消す。pointer-events の
       解釈差や他 CSS の上書きがあっても、閉じた後の透明パネルが裏のゲームの
       クリックを奪わないための二重ガード（開閉時のインライン指定と併用） */
    '#pwDrawerWrap:not(.open) #pwDrawerScrim{pointer-events:none!important}',
    '#pwDrawerWrap:not(.open) #pwDrawer{pointer-events:none!important}',
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
    '.pw-fb-body{white-space:pre-wrap;word-break:break-word;font-size:13.5px;line-height:1.7;color:#e6e9f7;background:rgba(255,255,255,.04);border-radius:12px;padding:12px;margin-top:8px}',
    /* プロフィールのポップアップ（画面中央モーダル。フィードバックと同じ作法） */
    '#pwProfileWrap{position:fixed;inset:0;z-index:100050;display:none;align-items:flex-start;justify-content:center;background:rgba(3,4,12,.62);backdrop-filter:blur(3px);font-family:"Hiragino Kaku Gothic ProN","Noto Sans JP",system-ui,sans-serif;padding:5vh 14px 14px;box-sizing:border-box}',
    '#pwProfileWrap.open{display:flex}',
    '#pwProfileWrap *{box-sizing:border-box}',
    '.pw-prof-card{position:relative}',
    '.pw-prof-x{position:absolute;top:10px;right:10px;z-index:2}',
    /* フレンド検索の結果カード（タップで申請できる状態の時だけポインタ） */
    '.pwf-req-card.tap{cursor:pointer}'
  ].join('\n');
  var headerEl = null, drawerWrapEl = null, drawerOpen = false;
  var fbOpen = false;   /* フィードバックモーダル（#pwFbWrap）の開閉状態 */

  /* ---------------- オーバーレイ開閉イベント（ゲーム側のポーズ連動用） ----------------
     ドロワーとフィードバックモーダルの開閉を document へ通知する。
     ゲーム側は document.addEventListener('pw:overlay', handler) で購読でき、
     handler には detail = { open: どちらか1つでも開いているか,
     drawer: bool, feedback: bool, source: 'drawer'|'feedback' } が渡る。
     PWAccount.onOverlayChange(cb) / PWAccount.overlayOpen() でも同じ状態を取れる。
     発火は「開閉状態が実際に変わった時」だけ（多重 open/close では発火しない） */
  var overlayCbs = [];
  function overlayOpenNow() { return !!(drawerOpen || fbOpen); }
  function emitOverlay(source) {
    var detail = { open: overlayOpenNow(), drawer: !!drawerOpen, feedback: !!fbOpen, source: source || 'drawer' };
    try { document.dispatchEvent(new CustomEvent('pw:overlay', { detail: detail })); } catch (e) {}
    overlayCbs.slice().forEach(function (cb) { try { cb(detail); } catch (e) {} });
  }
  /* 閉じたドロワーがクリックを奪わないよう、開閉に合わせてスクリム/ドロワーへ
     インラインでも pointer-events を明示する（CSS の visibility/pointer-events
     ガードと合わせた三重化）。閉時は inert＋aria-hidden でフォーカスも止める */
  function setDrawerHitState() {
    if (!drawerWrapEl) return;
    var scrim = drawerWrapEl.querySelector('#pwDrawerScrim');
    var drawer = drawerWrapEl.querySelector('#pwDrawer');
    if (scrim) scrim.style.pointerEvents = drawerOpen ? '' : 'none';
    if (drawer) {
      drawer.style.pointerEvents = drawerOpen ? '' : 'none';
      try { drawer.inert = !drawerOpen; } catch (e) {}
      try { drawer.setAttribute('aria-hidden', drawerOpen ? 'false' : 'true'); } catch (e) {}
    }
  }
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
      '<div id="pwFriendsSec" data-pw-member-only style="display:none">' +
      '<div class="pw-drawer-sec">👥 フレンド</div>' +
      '<div id="pwFriendsMount"></div>' +
      '</div>' +
      '<div id="pwFeedbackSec">' +
      '<button class="pwa-btn sub" id="pwaFeedbackBtn" style="margin-top:16px">📮 お問い合わせ・要望・バグ報告</button>' +
      '</div>' +
      '<div class="pwa-note" data-pw-guest-note style="display:none;margin-top:16px">いまはゲストとして遊んでいます。ゲストでは1人用モードのみです。セーブはこの端末に保存されますが、ログインするとクラウドにも控えが送られ、別の端末でも続きが遊べるようになります。</div>' +
      '<div id="pwFbAdminSec" style="display:none">' +
      '<div class="pw-drawer-sec">📮 意見ボックス（管理者用）</div>' +
      '<div id="pwFbInbox"><div class="pwa-note">読み込み中…</div></div>' +
      '</div>' +
      '</aside>';
    document.body.appendChild(drawerWrapEl);
    setDrawerHitState();
    drawerWrapEl.querySelector('#pwDrawerScrim').addEventListener('click', closeModal);
    drawerWrapEl.querySelector('#pwDrawerClose').onclick = closeModal;
    /* お問い合わせボタンはドロワー内の固定セクション（フレンド欄の下）に置く。
       updateModal の本文には含めない（並び順をフレンド欄より下に固定するため） */
    drawerWrapEl.querySelector('#pwaFeedbackBtn').onclick = function () { openFeedback(); };
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
  /* フレンド欄（#pwFriendsSec）の置き場所の付け替え。
     定位置は #pwaBody の直後（お問い合わせ欄より上）。ログイン中は
     アカウント概要の直後・ログアウトボタンより上に見せたいので、
     ログイン中テンプレート内の #pwFriendsAnchor の位置へ差し込む。
     #pwaBody は updateModal が innerHTML ごと描き直すため、差し込んだまま
     描き直すとフレンド欄（マウント済みパネルごと）消えてしまう。
     描き直しの前に必ず定位置へ避難させ、描き直した後に差し込み直す。
     DOM の移動（replaceChild / insertBefore）は子要素と結線を保持するので、
     friends.js のパネル参照（els.panel）や renderAll の対象は壊れない */
  function rescueFriendsSec() {
    var sec = $('pwFriendsSec'), body = $('pwaBody');
    if (!sec || !body || sec.parentNode !== body) return;
    var fbSec = $('pwFeedbackSec');
    if (fbSec && fbSec.parentNode === body.parentNode) body.parentNode.insertBefore(sec, fbSec);
    else if (body.nextSibling) body.parentNode.insertBefore(sec, body.nextSibling);
    else body.parentNode.appendChild(sec);
  }
  function placeFriendsSecAtAnchor() {
    var sec = $('pwFriendsSec'), anchor = $('pwFriendsAnchor');
    if (!sec || !anchor || !anchor.parentNode) return;
    anchor.parentNode.replaceChild(sec, anchor);
  }
  function updateModal() {
    var body = $('pwaBody');
    if (!body) return;
    rescueFriendsSec();
    if (sdkState === 'loading') {
      body.innerHTML = '<div class="pwa-note">読み込み中…</div>';
      return;
    }
    if (sdkState === 'unavailable' || !fb) {
      body.innerHTML = '<div class="pwa-note err">ログイン機能を読み込めませんでした（通信環境を確認してください）。この環境ではゲスト扱いとなり、1人用モードのみ遊べます（マルチプレイ・フレンドは使えません）。セーブはこの端末に保存されるので、通信が回復してログインすればクラウドにも同期されます。</div>';
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
        (myChar ? '<div class="pwa-note">🎴 使用キャラ（リンクドラムサーガ）: <b style="color:#fde68a">' + esc(myChar) + '</b></div>' : '') +
        '<button class="pwa-btn sub" id="pwaProfEditBtn" style="margin-top:8px">✏️ プロフィールを編集</button>' +
        '<div id="pwaProfEditor"></div>' +
        '<div class="pw-drawer-sec">🎮 ゲーム別戦績</div>' + statsHTML(myStats) +
        '<div class="pwa-note" id="pwaStatus">' + esc(statusText || 'クラウドセーブ有効') + '</div>' +
        '<div class="pwa-note">セーブはこの端末に保存され、ログイン中はクラウドにも控えが送られます。別のアカウントでログインすると、そのアカウントのセーブに入れ替わります。</div>' +
        '<span id="pwFriendsAnchor"></span>' +
        '<button class="pwa-btn sub" id="pwaLogout" style="margin-top:12px">ログアウト</button>' +
        '<div class="pwa-note">ログアウトするとゲストに戻ります。データはこの端末とクラウドに残るので、再ログインすれば続きが遊べます。</div>' +
        '<button class="pwa-btn sub" id="pwaExportBtn" style="margin-top:14px">📤 バックアップを書き出し</button>' +
        '<div class="pwa-note">現在のセーブをJSONファイルとして保存します。端末を変える前や、大事な記録がある時に書き出しておくと、下の「バックアップから復元」で戻せます。</div>' +
        '<button class="pwa-btn sub" id="pwaRestoreBtn" style="margin-top:14px">📥 バックアップから復元</button>' +
        '<input type="file" id="pwaRestoreFile" accept=".json" style="display:none">' +
        '<div class="pwa-note">ポータルで書き出したバックアップ（JSONファイル）を選ぶと、その時点のセーブで現在のセーブを上書きします。</div>' +
        '<button class="pwa-btn sub" id="pwaResetData" style="margin-top:14px;color:#fca5a5;border-color:rgba(239,68,68,.45)">🗑 セーブデータを初期化</button>' +
        '<div class="pwa-note">全ゲームのセーブと戦績を、この端末とクラウドから完全に削除します（元に戻せません）。</div>';
      placeFriendsSecAtAnchor();
      $('pwaLogout').onclick = function () { doLogout(); };
      $('pwaResetData').onclick = function () {
        var btn = $('pwaResetData');
        if (!window.confirm('セーブデータを初期化しますか？\n全ゲームのセーブと戦績がこの端末とクラウドから完全に削除され、元に戻せません。')) return;
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
      $('pwaExportBtn').onclick = function () {
        var r = exportBackup();
        if (r && r.ok === false) window.alert(r.msg || '書き出せませんでした');
      };
      $('pwaRestoreBtn').onclick = function () {
        /* ログイン前はファイル選択自体を開かない（何も書き込まない） */
        if (!me) { setStatus('データの読み込み完了後に実行してください'); return; }
        var fi = $('pwaRestoreFile');
        if (fi) { try { fi.value = ''; } catch (e) {} fi.click(); }
      };
      $('pwaRestoreFile').onchange = function () {
        var f = this.files && this.files[0];
        if (!f) return;
        var reader = new FileReader();
        reader.onload = function () {
          var info = parseBackup(String(reader.result || ''));
          if (!info.ok) { setStatus(info.msg); window.alert(info.msg); return; }
          var when = info.exportedAt ? '\n書き出し日時: ' + info.exportedAt : '';
          if (!window.confirm('バックアップから復元しますか？' + when + '\n' + info.total + '件のデータで、現在のセーブを上書きします。')) return;
          var r = restoreFromBackup(info);
          var showRestoreResult = function (rr) {
            if (rr.ok) {
              var extra = (rr.skipped + rr.excluded) > 0 ? '\n（対象外 ' + (rr.skipped + rr.excluded) + '件は取り込みませんでした）' : '';
              window.alert(rr.msg + extra + '\n各ゲームを開き直すと反映されます。');
            } else {
              window.alert(rr.msg);
            }
          };
          /* 完了表示はクラウドへの保存が確認できてから出す */
          if (r && r.settled && typeof r.settled.then === 'function') r.settled.then(showRestoreResult);
          else showRestoreResult(r);
        };
        reader.onerror = function () { setStatus('ファイルの読み込みに失敗しました'); };
        reader.readAsText(f);
      };
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
      '<div class="pwa-note">いまはゲストとして遊んでいます。ゲストでは1人用モードのみです。セーブはこの端末に保存されますが、ログインするとクラウドにも控えが送られ、別の端末でも続きが遊べるようになります。</div>' +
      '<div class="pwa-note">お問い合わせ・要望・バグ報告は、ドロワー下部の「📮 お問い合わせ・要望・バグ報告」からゲストでも送れます。</div>';
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
  /* アカウントドロワーの開閉（旧モーダルの openModal/closeModal を置き換え。
     friends.js の loginNotice など既存の呼び出しはそのままドロワーを開く） */
  function openModal() {
    buildUI();
    if (!drawerWrapEl) return;
    var changed = !drawerOpen;
    drawerOpen = true;
    drawerWrapEl.classList.add('open');
    setDrawerHitState();
    updatePill(); updateModal();
    notifyFriendsView();
    if (changed) emitOverlay('drawer');
  }
  function closeModal() {
    if (!drawerWrapEl) { drawerOpen = false; return; }
    var changed = drawerOpen;
    drawerOpen = false;
    drawerWrapEl.classList.remove('open');
    setDrawerHitState();
    updatePill();
    notifyFriendsView();
    if (changed) emitOverlay('drawer');
  }
  /* フレンドパネル内の「ユーザー名で検索」行（器は friends.js 側）。
     表示切替は friends.js の renderAll() が毎回同期する（そちらが本線）。
     ここでも同じ条件で合わせるが、表示の最終保証は renderAll 側にある。
     検索ボタンの結線はこの下の document 委譲が担う（updateSearchRow は
     表示と注記の同期だけ） */
  function updateSearchRow() {
    var sec = $('pwfSearchSec');
    if (sec) sec.style.display = cloudActive() ? '' : 'none';
    var note = $('pwfFootNote');
    if (note && cloudActive()) {
      note.textContent = 'フレンドの追加は、相手のユーザー名を検索して「フレンド申請」を送り、相手が承認するとフレンドになります。ログイン中はフレンドの在席・招待がクラウド経由で届きます（相手がオフラインでも届きます）。';
    }
  }
  /* 検索結果カード: アイコン・ユーザー名・オンライン状態＋状態に応じた操作。
     未申請なら「カードのタップ」でも「フレンド申請」ボタンでも申請できる */
  function renderSearchResult(found) {
    var box = $('pwfSearchResult');
    if (!box) return;
    if (!found) { box.innerHTML = ''; return; }
    var st = friendStateFor(found.uid);
    var online = found.online && (nowMs() - (found.lastSeen || 0) < PRESENCE_STALE_MS);
    var action = '';
    if (st === 'self') action = '<div class="pwa-note" style="margin-top:8px">あなた自身のユーザー名です</div>';
    else if (st === 'friend') action = '<div class="pwa-note" style="margin-top:8px">✅ フレンドです</div>';
    else if (st === 'outgoing') action = '<button class="pwa-btn sub" id="pwfReqCancel" style="margin-top:8px">申請中（タップで取り消し）</button>';
    else if (st === 'incoming') action = '<div class="pwa-note" style="margin-top:8px">この人からフレンド申請が届いています。下の「フレンド申請が届いています」から承認できます</div>';
    else action = '<button class="pwa-btn" id="pwfReqSend" style="margin-top:8px">👥 フレンド申請</button>';
    box.innerHTML =
      '<div class="pwf-req-card' + (st === 'none' ? ' tap' : '') + '" id="pwfReqCard">' +
      '<div class="pwa-prof" style="margin-top:10px">' + profileIconHTML(found, 40) +
      '<div class="pwa-prof-meta"><div class="pwa-user" style="margin:0">' + esc(found.username) + '</div>' +
      '<div class="pwa-note" style="margin:2px 0 0">' + (online ? 'オンライン' : 'オフライン') + '</div></div></div>' +
      (found.comment ? '<div class="pwa-prof-comment">💬 ' + esc(found.comment) + '</div>' : '') +
      action +
      '<div class="pwa-note" id="pwfReqMsg"></div></div>';
    var doSend = function () {
      var m = $('pwfReqMsg');
      if (m) m.textContent = '申請を送っています…';
      sendFriendRequest(found.username).then(function (r) {
        renderSearchResult(found);
        var m2 = $('pwfReqMsg');
        if (m2) { m2.textContent = r.msg; if (!r.ok) m2.classList.add('err'); }
      });
    };
    var send = $('pwfReqSend');
    if (send) send.onclick = function (e) { e.stopPropagation(); send.disabled = true; doSend(); };
    if (st === 'none') {
      var card = $('pwfReqCard');
      if (card) card.onclick = doSend;
    }
    var cancel = $('pwfReqCancel');
    if (cancel) cancel.onclick = function () {
      cancel.disabled = true;
      cancelFriendRequest(found.uid).then(function () {
        renderSearchResult(found);
        var m = $('pwfReqMsg');
        if (m) m.textContent = '申請を取り消しました';
      });
    };
  }
  /* 検索の結線は document へのイベント委譲で1回だけ行う。
     旧方式（ボタン要素への直接結線＋約10秒のポーリング）は、通信が遅い環境で
     パネル構築がポーリング打ち切り後になるとボタンが無反応のまま固定される
     欠陥があった（表示が直っても検索できない）。委譲ならパネルの構築・
     再構築のタイミングに左右されず、二重結線にもならない。
     検索 → 結果カード表示 → カードのタップ or 「フレンド申請」ボタンで申請 */
  document.addEventListener('click', function (e) {
    var t = e.target;
    var btn = (t && t.closest) ? t.closest('#pwfSearchBtn') : null;
    if (!btn) return;
    var input = $('pwfSearchName'), n = $('pwfSearchNote');
    if (!input || !n) return;
    var name = input.value.trim();
    n.classList.remove('err');
    /* 形式が違う名前は「見つかりませんでした」ではなく形式エラーを出す
       （searchUser は形式不正も null を返すため、そのままだと誤解を招く） */
    var v = validateUsername(name);
    if (!v.ok) { n.textContent = v.error; n.classList.add('err'); return; }
    btn.disabled = true; n.textContent = '検索中…';
    renderSearchResult(null);
    searchUser(name).then(function (found) {
      btn.disabled = false;
      if (!found) {
        n.textContent = 'そのユーザー名の人は見つかりませんでした';
        n.classList.add('err');
        return;
      }
      n.textContent = '';
      renderSearchResult(found);
    });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    var t = e.target;
    if (!t || t.id !== 'pwfSearchName') return;
    var btn = $('pwfSearchBtn');
    if (btn) btn.click();
  });

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
  /* フレンド（または自分）のプロフィールを画面中央のポップアップで出す。
     フィードバックモーダル（#pwFbWrap）と同じ作法のオーバーレイ＋カードで、
     背景タップと×ボタンで閉じる */
  var profileWrapEl = null;
  function buildProfilePopup() {
    if (profileWrapEl) return;
    profileWrapEl = document.createElement('div');
    profileWrapEl.id = 'pwProfileWrap';
    profileWrapEl.innerHTML =
      '<div class="pw-fb-card pw-prof-card">' +
      '<button class="pw-x pw-prof-x" id="pwProfileClose" aria-label="閉じる">✕</button>' +
      '<div id="pwProfileCard"></div></div>';
    document.body.appendChild(profileWrapEl);
    profileWrapEl.addEventListener('click', function (e) { if (e.target === profileWrapEl) closeProfile(); });
    profileWrapEl.querySelector('#pwProfileClose').onclick = closeProfile;
  }
  function closeProfile() {
    if (profileWrapEl) profileWrapEl.classList.remove('open');
  }
  function openProfile(uid) {
    buildUI();
    buildProfilePopup();
    var view = $('pwProfileCard');
    if (!view || !profileWrapEl) return;
    profileWrapEl.classList.add('open');
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
    view.innerHTML = '<div class="pwa-note">読み込み中…</div>';
    if (!fb) { view.innerHTML = '<div class="pwa-note">プロフィールを読み込めませんでした</div>'; return; }
    userDoc(uid).get().then(function (doc) {
      if (!doc.exists) {
        view.innerHTML = '<div class="pwa-note">プロフィールが見つかりませんでした</div>';
        return;
      }
      var data = doc.data() || {};
      renderProfileView(view, {
        name: data.username || 'フレンド', iconId: data.iconId || '', iconColor: data.iconColor || '',
        comment: data.comment || '', online: !!data.online, lastSeen: data.lastSeen || 0,
        game: data.currentGame || null, stats: data.stats || null, mainChar: data.mainChar || ''
      });
    }).catch(function () {
      view.innerHTML = '<div class="pwa-note">プロフィールを読み込めませんでした</div>';
    });
  }
  function renderProfileView(view, p) {
    var playing = p.online && p.game && GAME_TITLES[p.game] && (p.lastSeen && nowMs() - p.lastSeen < PRESENCE_STALE_MS);
    view.innerHTML =
      '<div class="pwa-prof">' + profileIconHTML(p, 56) +
      '<div class="pwa-prof-meta"><div class="pwa-user" style="margin:0">' + esc(p.name || 'プレイヤー') + '</div>' +
      '<div class="pwa-note" style="margin:2px 0 0">' + esc(relLastSeenText(p)) + (playing ? '・' + esc(GAME_TITLES[p.game]) + 'でプレイ中' : '') + '</div></div></div>' +
      (p.comment ? '<div class="pwa-prof-comment">💬 ' + esc(p.comment) + '</div>' : '') +
      (p.mainChar ? '<div class="pwa-note">🎴 使用キャラ（リンクドラムサーガ）: <b style="color:#fde68a">' + esc(p.mainChar) + '</b></div>' : '') +
      '<div class="pw-drawer-sec">🎮 ゲーム別戦績</div>' + statsHTML(p.stats);
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
    /* v92: 提供終了した6ゲームは対象ゲームの選択肢に出さない。
       GAME_TITLES 自体は過去の戦績・意見・在席表示のゲーム名表示に使うため残す */
    var FB_REMOVED_GAMES = { crepe: 1, frostline: 1, gamedev: 1, numguess: 1, janken: 1, dice: 1, mole: 1, simon: 1, memory: 1, calc: 1, reaction: 1, mash: 1, otome: 1, linksaga: 1, timing: 1 };
    var gameOpts = '<option value="">（ゲーム共通・その他）</option>' + Object.keys(GAME_TITLES).filter(function (g) { return g !== 'portal' && !FB_REMOVED_GAMES[g]; }).map(function (g) {
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
    var changed = !fbOpen;
    fbOpen = true;
    fbWrapEl.classList.add('open');
    if (changed) emitOverlay('feedback');
  }
  function closeFeedback() {
    if (fbWrapEl) fbWrapEl.classList.remove('open');
    if (fbOpen) { fbOpen = false; emitOverlay('feedback'); }
  }
  /* 送信タイムアウト（15秒）。通信が詰まると Firestore の add() の
     Promise が解決も拒否もされないまま残ることがあり、そのままだと
     送信ボタンが「送信中…」で固まる。時間切れは「失敗」として確定させ、
     確定後に add() が遅れて成功しても結果は覆らない（完了表示に化けない）。
     テスト用に _test.setFeedbackTimeoutMs で差し替え可能 */
  var FB_SUBMIT_TIMEOUT_MS = 15000;
  function submitFeedback(data) {
    if (!fb) return Promise.resolve({ ok: false, msg: '送信できませんでした（通信環境を確認してください）' });
    var payload = {
      type: FB_TYPE_LABELS[data.type] ? data.type : 'contact',
      title: String(data.title || '').slice(0, 100),
      body: String(data.body || '').slice(0, 2000),
      game: data.game || '',
      fromUid: me ? me.uid : '',
      fromName: String(data.fromName || '').slice(0, 30),
      createdAt: nowMs(),
      status: 'new'
    };
    return new Promise(function (resolve) {
      var settled = false;
      var timer = setTimeout(function () {
        finish({ ok: false, timeout: true, msg: '送信できませんでした。通信環境を確認して、もう一度お試しください' });
      }, FB_SUBMIT_TIMEOUT_MS);
      function finish(r) {
        if (settled) return; /* 一度確定したら、遅れてきた結果では覆さない */
        settled = true;
        clearTimeout(timer);
        resolve(r);
      }
      var addPromise;
      try {
        addPromise = fb.db.collection('feedback').add(payload);
      } catch (e) {
        finish({ ok: false, msg: '送信できませんでした' + (e && e.code ? '（' + e.code + '）' : '') });
        return;
      }
      Promise.resolve(addPromise).then(function () { finish({ ok: true }); })
        .catch(function (e) { finish({ ok: false, msg: '送信できませんでした' + (e && e.code ? '（' + e.code + '）' : '') }); });
    });
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
    var gotFirst = false;
    var applyFirst = function (snap) { gotFirst = true; apply(snap); };
    try {
      var unsub = fb.db.collection('feedback').onSnapshot(applyFirst, function () {
        fb.db.collection('feedback').get().then(apply).catch(function () { renderAdminInboxError(); });
      });
      unsubs.push(unsub);
      /* 環境によっては購読（onSnapshot）の初回配送が来ないまま固まることが
         あるため、6秒来なければ単発取得で補う（v75） */
      setTimeout(function () {
        if (!gotFirst) {
          fb.db.collection('feedback').get().then(apply).catch(function () { renderAdminInboxError(); });
        }
      }, 6000);
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
    /* ドロワー/フィードバックモーダルのどちらかが開いているか（ゲーム側のポーズ連動用）。
       開閉は document の 'pw:overlay' イベントでも通知される */
    overlayOpen: function () { return overlayOpenNow(); },
    onOverlayChange: function (cb) {
      if (typeof cb !== 'function') return;
      overlayCbs.push(cb);
      try { cb({ open: overlayOpenNow(), drawer: !!drawerOpen, feedback: !!fbOpen, source: 'init' }); } catch (e) {}
    },
    syncNow: function () { flushUploads(); return mergeCloudSaves({ force: true }); },
    /* v66〜 自分のセーブ全削除（端末ストア＋同期メタ＋クラウド）＋公開戦績リセット */
    resetMyData: resetMyData,
    /* バックアップ JSON（文字列またはパース済みオブジェクト）を取り込む。
       ログイン中のみ実行される */
    restoreBackup: restoreFromBackup,
    /* v73〜 現在のセーブをバックアップ JSON として書き出す。
       ログイン中のみ有効。戻り値はペイロード {app, version, exportedAt, data} */
    exportBackup: exportBackup,
    searchUser: searchUser,
    sendFriendRequest: sendFriendRequest,
    cancelFriendRequest: cancelFriendRequest,
    respondFriendRequest: respondFriendRequest,
    friendStateFor: friendStateFor,
    sendInviteCloud: sendInviteCloud,
    consumeInvite: consumeInvite,
    dismissInvite: dismissInvite,
    withdrawInviteCloud: withdrawInviteCloud,
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
    /* 自分のアカウント作成日時（ms 数値）。プロフィール文書の createdAt を
       優先し、無い場合は Auth の作成記録（metadata.creationTime）を使う。
       どちらも取得できなければ null */
    myCreatedAt: function () { return myCreatedAtMs; },
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
      dirtyKeys: function () { var c = {}; Object.keys(dirtyKeys).forEach(function (k) { c[k] = true; }); return c; },
      /* ゲスト相当の分離状態か（ログイン中は false / それ以外は true） */
      guestActive: function () { return gateState !== 'member'; },
      overlayOpen: function () { return overlayOpenNow(); },
      /* 端末ストアの内容 {素キー: 値}（認証状態によらず実ディスクの素キー） */
      memStore: function () { return storeSnapshot(); },
      statusText: function () { return statusText; },
      inFlightKeys: function () { var c = {}; Object.keys(uploadInFlight).forEach(function (k) { c[k] = true; }); return c; },
      /* クラウドとのマージが完了した uid（旧称 hydratedUid と同じ役割） */
      hydratedUid: function () { return mergedUid; },
      mergedUid: function () { return mergedUid; },
      /* v74: 端末ストアの所有者 uid（旧 storeUid フックの互換名も残す。
         実態は「最後に引き継ぎ処理を行った uid」＝ syncMeta.owner） */
      storeUid: function () { return storeOwner; },
      storeOwner: function () { return storeOwner; },
      syncMeta: function () { return syncMeta ? JSON.parse(JSON.stringify(syncMeta)) : null; },
      /* v72 でシード（window.name 引き継ぎ）は廃止。互換のため false を返す */
      seededFromStash: function () { return false; },
      /* v74 で起動時パージは廃止。互換のため空配列を返す */
      purgeKeyList: function () { return []; },
      computeStats: computeMyStats,
      createdAtToMs: createdAtToMs,
      readMainChar: readMainChar,
      publishExtras: publishProfileExtras,
      setAdminUids: function (arr) {
        ADMIN_UIDS = (arr || []).slice();
        refreshAdminUI();
        if (cloudActive()) startAdminInbox();
      },
      adminUids: function () { return ADMIN_UIDS.slice(); },
      inboxItems: function () { return fbInboxItems.slice(); },
      /* フィードバック送信タイムアウト（ms）の差し替え（テスト用） */
      setFeedbackTimeoutMs: function (ms) { if (typeof ms === 'number' && ms > 0) FB_SUBMIT_TIMEOUT_MS = ms; },
      feedbackTimeoutMs: function () { return FB_SUBMIT_TIMEOUT_MS; },
      /* フレンド申請の現在状態（受信 pending 一覧と送信分） */
      friendRequests: function () {
        return {
          in: friendReqInList(),
          out: Object.keys(friendReqOut).map(function (id) {
            var r = friendReqOut[id];
            return { id: id, toUid: r.toUid, toName: r.toName, status: r.status };
          })
        };
      }
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
