(function(){
  'use strict';
  const $=id=>document.getElementById(id),el=(tag,cls,text)=>{const n=document.createElement(tag);n.className=cls||'';if(text!=null)n.textContent=text;return n;};
  const price=n=>Number.isFinite(n)?n.toLocaleString('en-US',{maximumSignificantDigits:9}):'—';
  const money=n=>Number.isFinite(n)?(n>0?'+':'')+n.toFixed(2):'—';
  const time=n=>n?new Date(n).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'—';
  const labels={NOT_ENTERED:'未進場',WAITING_PRICE:'待進場',OPEN:'持倉中',TAKE_PROFIT:'已平倉',STOP_LOSS:'已平倉',REVIEW:'待核對',SKIPPED:'已取消'};
  const summary=$('paperSummary');document.querySelector('.desk-intro').after(summary);
  $('paperAccountSlot').append($('sharedAccount'));
  // Preserve the existing account elements, including their IDs, when relocating.
  window.DashboardUI={updateSummary(){},setCandidates(){}};
  const box=(label,value,cls='')=>{const n=el('div','signal-box '+cls);n.append(el('span','',label),el('strong','',value));return n;};
  let lastTrades=[],lastModel=null,lastNow=0,watched='';
  function renderCards(trades,model,now){
    lastTrades=trades;lastModel=model;lastNow=now;
    const host=$('signalCards'),open=new Set([...host.querySelectorAll('details[open]')].map(n=>n.dataset.id));host.replaceChildren();
    const symbols=[...new Set(trades.slice(0,200).map(t=>t.symbol))].sort(),key=symbols.join(',');
    if(key!==watched){watched=key;window.CatPriceFeed.setScannerSymbols(symbols);}
    if(!trades.length){host.append(el('p','single-empty','尚無符合條件的紀錄。掃描後符合策略的訊號會自動加入。'));return;}
    for(const t of trades){
      const card=el('article','signal-card'),long=t.direction==='LONG',closed=window.PaperEngine.CLOSED.has(t.status),entry=t.entry||t.referenceEntry;
      const head=el('header','signal-head'),identity=el('div','signal-identity'),badges=el('div','signal-badges');
      identity.append(el('span','signal-avatar',t.symbol.replace(/^1000/,'').slice(0,1)),el('h3','',t.symbol));
      badges.append(el('span',long?'long':'short',long?'做多':'做空'),el('span',closed?'closed':'',t.recovery?.pending?'核對中':t.exitReason?.startsWith('RETRACE_')?'回撤出場':labels[t.status]||t.status));head.append(identity,badges);
      card.append(head,el('p','signal-meta','BINANCE 永續 · '+(t.timeframeLabel||'舊策略')+' · '+(t.strategyVersion==='ema20-60-bos-dual-v1'?'EMA20 / EMA60':'舊策略紀錄')),el('p','signal-time',(t.openedAt?'開單時間 ':'訊號時間 ')+time(t.openedAt||t.confirmedAt)));
      const quote=window.CatPriceFeed.get(t.symbol),fresh=quote?.fresh;
      card.append(box(fresh?'Binance 現價':'Binance 現價 · 等待報價',fresh?price(quote.price):'—','wide current'));
      const pnl=closed?t.netPnl:t.status==='OPEN'&&!t.recovery?.pending&&Number.isFinite(t.lastPrice)?model.netAt(t,t.lastPrice).net:null;
      const pnlBox=box(closed?'最終損益 · USDT':'浮動損益 · USDT',money(pnl),'wide '+(pnl<0?'negative':'positive'));
      if(Number.isFinite(pnl)&&t.entry&&t.quantity)pnlBox.append(el('small','',money(pnl/(t.entry*t.quantity)*100)+'% · 名目本金報酬'));
      card.append(pnlBox);
      const grid=el('div','signal-price-grid');grid.append(box('進場價格',price(entry),'entry'),box('SL',price(t.stopLoss),'stop'));
      const targets=t.plannedTargets||[];
      targets.forEach((p,i)=>{const b=box((i===3?'FTP / TP4':'TP'+(i+1))+' · '+[20,30,30,20][i]+'%',price(p),'target');const r=Math.abs(p-entry)/Math.abs(entry-t.stopLoss);b.append(el('small','',Number.isFinite(r)?r.toFixed(2)+'R':'—'));if(t.targets?.[i]?.status==='HIT')b.classList.add('hit');grid.append(b);});
      card.append(grid);
      if(t.exitGuard&&t.status==='OPEN')card.append(el('p','signal-guard','回撤保護 '+price(t.exitGuard.price)+' · 觸及即出清剩餘'));
      const detail=el('details','signal-detail');detail.dataset.id=t.id;detail.open=open.has(t.id);detail.append(el('summary','','交易明細'),el('p','',t.recovery?.pending?(t.recovery.lastError||'正在核對中斷期間成交'):t.reason||'等待掃描完成'));
      detail.append(el('p','','部位 '+price(t.remainingQuantity??t.reservedPlan?.quantity)+' / '+price(t.quantity??t.reservedPlan?.quantity)+' · 風險 '+price(t.estimatedStopRisk??t.reservedPlan?.risk)+' USDT'));
      if(t.fib?.kind==='BOS_RETEST')detail.append(el('p','','BOS '+price(t.fib.pivot.price)+' · 突破量 / 前20均量 '+(t.fib.breakBar.volume/t.fib.averageVolume).toFixed(2)+' 倍 · SMA83 '+price(t.fib.trend.sma83)+' · EMA200 '+price(t.fib.trend.ema200)));
      if(t.exitFills?.length)detail.append(el('p','',t.exitFills.map(f=>f.label+' '+price(f.quantity)+' @ '+price(f.price)).join('；')));
      card.append(detail);host.append(card);
    }
  }
  function renderWatchlist(observations){let host=document.getElementById('trendCandidates');if(!host){host=el('div','signal-cards');host.id='trendCandidates';document.getElementById('signalCards').before(host);}host.replaceChildren();for(const o of observations.filter(o=>o.direction&&o.status!=='CANDIDATE')){const card=el('article','signal-card');card.append(el('h3','',o.symbol),el('p','signal-meta',o.timeframeLabel+' · '+(o.direction==='LONG'?'做多候選':'做空候選')),el('p','signal-guard','等待回調 · 尚未進場'),el('p','signal-meta',o.reason));host.append(card);}}
  window.SinglePage={renderCards,renderWatchlist};
  let queued=false;window.CatPriceFeed.subscribe(()=>{if(queued)return;queued=true;setTimeout(()=>{queued=false;if(lastModel)renderCards(lastTrades,lastModel,lastNow);},500);});
})();
