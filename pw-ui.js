(function(){
  'use strict';
  if(window.__pwUnifiedUiLoaded)return;
  window.__pwUnifiedUiLoaded=true;
  var file=(location.pathname.split('/').pop()||'index.html').toLowerCase();
  var titles={
    index:'ゲームポータル',tetris:'テトリス',suica:'スイカゲーム',crepe:'クレープ工房',survivors:'まじょねこサバイバーズ',
    blockblast:'ブロックブラスト',minesweeper:'マインスイーパ',reversi:'オセロ',shogi:'将棋',majan:'麻雀',daihugou:'大富豪',
    hanahuda:'花札',uno:'UNO',blockzushi:'ブロック崩し',jump:'ジャンプラン',caring:'育成ゲーム',gamedev:'ゲーム工房物語',
    rpg:'モンスターライズ',otome:'乙女ゲーム'
  };
  var id=file.replace(/\.html$/,'')||'index';
  if(file==='rpg2.html')return;
  var title=titles[id]||document.title.replace(/\s*[|｜].*$/,'').trim()||'ゲーム';
  document.body.classList.add(id==='index'?'pw-portal':'pw-game-page');
  var bar=document.createElement('div');
  bar.className='pw-global-bar';
  bar.innerHTML='<a class="pw-brand pw-home-link" href="index.html" aria-label="PlayWebホームへ戻る"><span class="pw-brand-mark">P</span><span>PLAYWEB</span></a><div class="pw-game-chip" title="'+title+'">'+title+'</div>';
  document.body.appendChild(bar);
  var timer;
  function dim(){clearTimeout(timer);timer=setTimeout(function(){bar.classList.add('is-dim')},4200)}
  ['pointerdown','touchstart','keydown'].forEach(function(e){document.addEventListener(e,function(){bar.classList.remove('is-dim');dim()},{passive:true})});
  dim();
})();
