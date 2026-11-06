(function(){
  'use strict';
  const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n;};
  const finite=Number.isFinite,price=v=>finite(v)?v.toLocaleString('en-US',{maximumSignificantDigits:9}):'—';
  const signed=(v,decimals=2)=>finite(v)?(v>0?'+':'')+v.toFixed(decimals):'—';
  const date=v=>v?new Date(v).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'—';
  const labels={OPEN:'持倉中',WAITING_PRICE:'待進場',NOT_ENTERED:'未進場',SKIPPED:'已取消',TAKE_PROFIT:'已平倉',STOP_LOSS:'已平倉',REVIEW:'待核對',TIME_EXIT:'已平倉',WATCH:'方向候選'};
  function render(t,{plan=null,pnl=null,watch=false,retained=false,now=Date.now()}={}){
    const long=t.direction==='LONG',closed=['TAKE_PROFIT','STOP_LOSS','TIME_EXIT'].includes(t.status),status=watch?'WATCH':t.status||'NOT_ENTERED';
    const card=el('article','trade-glass strategy-card');card.dataset.direction=t.direction;card.dataset.status=status;card.dataset.key=t.id||[t.symbol,t.profileId,t.setupId||'watch'].join(':');
    const entry=t.entry??t.referenceEntry,targets=t.plannedTargets||(Array.isArray(t.targets)&&typeof t.targets[0]==='number'?t.targets:[]);
    const quote=window.CatPriceFeed?.get?.(t.symbol),mark=quote?.fresh?quote.price:finite(t.lastPrice)&&now-t.lastQuoteAt<=30000?t.lastPrice:null;
    const state=t.recovery?.pending?'核對中':labels[status]||status;
    const head=el('header','tg-head'),identity=el('div','tg-identity'),name=el('h3','tg-symbol',String(t.symbol||'').replace(/USDT$/,''));name.append(el('small','','/USDT'));
    identity.append(el('span','tg-direction '+(long?'is-long':'is-short'),long?'做多':'做空'),name);head.append(identity,el('span','tg-state',state));card.append(head);

    const structure=window.MacdStrategy.isVersion(t.strategyVersion),fib=window.SmcEntry.isFib(t),strategy=t.strategyName||(structure?'4H趨勢＋15M回調結構':'MACD＋SMC');
    card.append(el('p','tg-meta',strategy+' · '+(t.timeframeLabel||'4H＋15M')+' · '+date(t.openedAt||t.confirmedAt||t.detectedAt)+(retained?' · 保留紀錄':'')));
    divergenceNotice(card,t.macdDivergence);
    if(fib)card.append(el('p','tg-meta',t.entryLocation==='FIB_0715'?'掛單：Fib 0.715（OB內）':'掛單：OB近端'));
    const pnlRow=el('div','tg-pnl-row'),pnlBlock=el('div','tg-pnl'),pct=finite(pnl)&&t.entry&&t.quantity?100*pnl/(t.entry*t.quantity):null;
    pnlBlock.dataset.tone=finite(pnl)?pnl<0?'negative':'positive':'neutral';pnlBlock.append(el('strong','',finite(pct)?signed(pct,1)+'%':'—'),el('span','',closed?'已實現費後':t.status==='OPEN'?'持倉費後估算':'尚未成交'));
    if(finite(pnl))pnlBlock.append(el('small','',signed(pnl)+' USDT · 以名目本金計'));
    const quoteBlock=el('div','tg-quote');quoteBlock.append(el('span','','價格 '+(mark&&entry?signed((mark-entry)/entry*100)+'%':'—')),el('span','','現價 '+price(mark)));pnlRow.append(pnlBlock,quoteBlock);card.append(pnlRow);
    const ladder=el('div','tg-ladder');
    function level(label,value,{kind='',note='',hit=false}={}){const row=el('div','tg-level '+kind+(hit?' is-hit':''));row.append(el('span','tg-level-label',label),el('i','tg-level-rule'),el('strong','tg-level-price',price(value)),el('span','tg-level-note',hit?'✓':note));ladder.append(row);}
    for(let i=targets.length-1;i>=0;i--){const target=Array.isArray(t.targets)&&typeof t.targets[i]==='object'?t.targets[i]:null;const rr=entry&&t.stopLoss?Math.abs(targets[i]-entry)/Math.abs(entry-t.stopLoss):null;level(fib?'TP'+(i+1):t.intradayEntry?'15M結構':'2R',targets[i],{kind:'tg-target',note:target?.status==='STOPPED'||target?.status==='EXITED'?'已結束':fib?Math.round(t.exitFractions[i]*100)+'% · '+[0,-.27,-.618,-1][i]:(rr?rr.toFixed(2)+'R · ':'')+'全出',hit:target?.status==='HIT'});}
    level('進場',entry,{kind:'tg-entry',note:t.openedAt?'●':watch?'—':'待成交'});
    if(t.exitGuard&&t.status==='OPEN')level('保護',t.exitGuard.price,{kind:'tg-guard',note:'回撤全出'});
    level('SL',t.stopLoss,{kind:'tg-stop',note:t.quantity?'剩餘 '+Math.round((t.remainingQuantity??t.quantity)/t.quantity*100)+'%':watch?'—':'原停損'});card.append(ladder);
    const events=[];
    if(t.openedAt)events.push({at:t.openedAt,label:'已進場',detail:price(t.entry),kind:'entry'});
    for(const f of t.exitFills||[])events.push({at:f.at,label:/^TP/.test(f.label)?f.label+' 觸及':['TIME_12H','DAY_FLAT'].includes(f.label)?'時間平倉':f.label.startsWith('RETRACE_')?'回撤出場':'停損出場',detail:price(f.price)+' · 出場 '+price(f.quantity),kind:/^TP/.test(f.label)?'hit':'exit'});
    if(t.exitGuard&&t.status==='OPEN')events.push({at:t.exitGuard.activatedAt,label:'回撤保護設於 '+price(t.exitGuard.price),detail:t.exitGuard.label+' · 剩餘部位回撤全出',kind:'guard'});
    const timeline=el('div','tg-timeline');
    for(const e of events.sort((a,b)=>a.at-b.at).slice(-4)){const row=el('div','tg-event '+e.kind);row.append(el('i','tg-event-dot'),el('strong','',e.label),el('small','',date(e.at)+' · '+e.detail));timeline.append(row);}
    if(!events.length)timeline.append(el('p','tg-wait',watch?'4H與15M MACD同向，先列候選；等待15M回調結構確認':t.reason||plan?.reason||'等待新成交觸價'));
    const bottom=el('footer','tg-bottom'),details=el('details','tg-details');details.append(el('summary','','詳細資訊'));
    details.append(el('p','',t.recovery?.pending?(t.recovery.lastError||'正在核對中斷期間成交'):t.reason||plan?.reason||'未取得風控預留'));
    if(fib){const f=t.fibSetup;details.append(el('p','','OB '+price(f.ob.low)+' ～ '+price(f.ob.high)+' · Fib 0.715 '+price(t.fibEntry)));details.append(el('p','','BOS '+date(f.bos.closeTime+1)+' · 波段確認 '+date(f.endpoint.confirmedAt)));details.append(el('p','','停損為BOS前結構外1 tick；四段30%／20%／20%／30%，不移動結構停損。'));}
    if(t.intradayEntry){const f=t.intradayEntry;details.append(el('p','','4H EMA50 '+price(f.trend.ema50)+' · 15M RSI(2) '+f.rsiPrevious.toFixed(1)+' → '+f.rsi.toFixed(1)));details.append(el('p','','15M結構確認於 '+date(f.target.confirmedAt)+' · 停損2ATR · 最長12小時／台北午夜平倉'));}
    if(t.fib?.lowMacd)details.append(el('p','','4H DIF '+price((t.fib.highMacd||t.fib.trend).dif)+' / 訊號線 '+price((t.fib.highMacd||t.fib.trend).signal)+'；15M DIF '+price(t.fib.lowMacd.dif)+' / 訊號線 '+price(t.fib.lowMacd.signal)));
    const quantity=t.quantity??t.reservedPlan?.quantity??plan?.quantity,risk=t.estimatedStopRisk??t.reservedPlan?.risk??plan?.risk;
    if(structure)details.append(el('p','','資金費率 '+(finite(t.fundingPaid)?signed(t.fundingPaid)+' USDT': '待同步')));
    if(finite(quantity))details.append(el('p','','原始數量 '+price(quantity)+' · 停損風險估算 '+price(risk)+' USDT'));
    if(finite(pct))details.append(el('p','','百分比為費後損益÷初始名目部位，單一目標全部出場。'));
    const copy=el('button','tg-copy','複製摘要');copy.type='button';copy.addEventListener('click',async()=>{const text=[t.symbol+' '+(long?'做多':'做空')+' · '+state,strategy+' · '+(t.timeframeLabel||'4H＋15M'),'進場 '+price(entry)+' · SL '+price(t.stopLoss),...targets.map((p,i)=>'TP'+(i+1)+' '+price(p)),finite(pnl)?'費後損益 '+signed(pnl)+' USDT':'尚未成交'].join('\n');try{await navigator.clipboard.writeText(text);copy.textContent='已複製';}catch{details.open=true;const area=el('textarea','tg-copy-text');area.value=text;area.readOnly=true;details.append(area);area.select();copy.textContent='請複製文字';}});bottom.append(details,copy);card.append(timeline,bottom);return card;
  }
  function paper(container,trades,model,now){const open=new Set([...container.querySelectorAll('details[open]')].map(d=>d.closest('[data-key]')?.dataset.key));container.replaceChildren();if(!trades.length){container.append(el('p','tg-empty','此篩選下尚無交易紀錄。'));return;}for(const group of (window.MarketGroups?window.MarketGroups.split(trades):[{items:trades}])){if(window.MarketGroups)container.append(window.MarketGroups.heading(group));for(const t of group.items){const pnl=['TAKE_PROFIT','STOP_LOSS','TIME_EXIT'].includes(t.status)?t.netPnl:t.status==='OPEN'&&!t.recovery?.pending&&finite(t.lastPrice)?model.netAt(t,t.lastPrice).net:null;const card=render(t,{pnl,now});if(open.has(card.dataset.key))card.querySelector('details').open=true;container.append(card);}}}
  function divergenceNotice(card,d){const labels={BULLISH:'底背離',BEARISH:'頂背離',BOTH:'頂／底背離',NONE:'未見已確認背離',INSUFFICIENT:'資料不足'};const row=el('p','tg-divergence','4H MACD：'+(labels[d?.state]||labels.INSUFFICIENT));row.dataset.state=d?.state||'INSUFFICIENT';card.append(row);if(d){const detail=el('details','tg-details');detail.append(el('summary','','4H背離數值'));for(const[name,pair]of[['低點',d.bottom],['高點',d.top]])if(Array.isArray(pair?.points)&&pair.points.length===2)detail.append(el('p','',name+' '+pair.points.map(p=>price(p.price)+'／DIF '+price(p.dif)+' · '+date(p.openTime)).join(' → ')));detail.append(el('p','','價格與同一根4H轉折K的DIF比較；左右各2根收盤確認。只作提醒，不參與進場篩選。'));card.append(detail);}}
  function watch(o){const long=o.direction==='LONG',card=el('article','trade-glass strategy-card'),head=el('header','tg-head'),identity=el('div','tg-identity'),name=el('h3','tg-symbol',o.symbol.replace(/USDT$/,''));name.append(el('small','','/USDT'));identity.append(el('span','tg-direction '+(long?'is-long':'is-short'),long?'做多候選':'做空候選'),name);head.append(identity,el('span','tg-state',o.status==='WAIT_PIVOT'?'等波段確認':'等15M結構'));card.dataset.key='watch:'+o.symbol;card.dataset.direction=o.direction;card.append(head,el('p','tg-meta','4H MACD定方向 · 15M順勢執行'));const q=window.CatPriceFeed?.get?.(o.symbol);card.append(el('p','watch-quote',(q?.fresh?'現價 ':'15M收盤 ')+price(q?.fresh?q.price:o.lastClose)));divergenceNotice(card,o.divergence);card.append(el('p','tg-wait',o.reason||'等待順勢BOS、OB與Fib波段'));const m=o.emaTrend;if(m)card.append(el('p','tg-meta','4H DIF '+price(m.dif)+' · Signal '+price(m.signal)));return card;}
  window.TradeCards={render,paper,watch};
})();
