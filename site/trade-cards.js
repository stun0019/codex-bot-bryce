(function(){
  'use strict';
  const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n;};
  const finite=Number.isFinite,price=v=>finite(v)?v.toLocaleString('en-US',{maximumSignificantDigits:9}):'—';
  const signed=(v,decimals=2)=>finite(v)?(v>0?'+':'')+v.toFixed(decimals):'—';
  const date=v=>v?new Date(v).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'—';
  const labels={OPEN:'持倉中',WAITING_PRICE:'待進場',NOT_ENTERED:'未進場',SKIPPED:'已取消',TAKE_PROFIT:'已平倉',STOP_LOSS:'已平倉',REVIEW:'待核對',WATCH:'MACD同向候選'};
  function render(t,{plan=null,pnl=null,watch=false,retained=false,now=Date.now()}={}){
    const long=t.direction==='LONG',closed=['TAKE_PROFIT','STOP_LOSS'].includes(t.status),status=watch?'WATCH':t.status||'NOT_ENTERED';
    const card=el('article','trade-glass strategy-card');card.dataset.direction=t.direction;card.dataset.status=status;card.dataset.key=t.id||[t.symbol,t.profileId,t.setupId||'watch'].join(':');
    const entry=t.referenceEntry??t.entry,targets=t.plannedTargets||(Array.isArray(t.targets)&&typeof t.targets[0]==='number'?t.targets:[]);
    const quote=window.CatPriceFeed?.get?.(t.symbol),mark=quote?.fresh?quote.price:finite(t.lastPrice)&&now-t.lastQuoteAt<=30000?t.lastPrice:null;
    const state=t.recovery?.pending?'核對中':labels[status]||status;
    const head=el('header','tg-head'),identity=el('div','tg-identity'),name=el('h3','tg-symbol',String(t.symbol||'').replace(/USDT$/,''));name.append(el('small','','/USDT'));
    identity.append(el('span','tg-direction '+(long?'is-long':'is-short'),long?'做多':'做空'),name);head.append(identity,el('span','tg-state',state));card.append(head);
    const strategy=t.strategyVersion===window.MacdStrategy.VERSION?'MACD':watch?'MACD':'舊策略';
    card.append(el('p','tg-meta',strategy+' · '+(t.timeframeLabel||'4H＋15M')+' · '+date(t.openedAt||t.confirmedAt||t.detectedAt)+(retained?' · 保留紀錄':'')));
    const pnlRow=el('div','tg-pnl-row'),pnlBlock=el('div','tg-pnl'),pct=finite(pnl)&&t.entry&&t.quantity?100*pnl/(t.entry*t.quantity):null;
    pnlBlock.dataset.tone=finite(pnl)?pnl<0?'negative':'positive':'neutral';pnlBlock.append(el('strong','',finite(pct)?signed(pct,1)+'%':'—'),el('span','',closed?'已實現費後':t.status==='OPEN'?'持倉費後估算':'尚未成交'));
    if(finite(pnl))pnlBlock.append(el('small','',signed(pnl)+' USDT · 以名目本金計'));
    const quoteBlock=el('div','tg-quote');quoteBlock.append(el('span','','價格 '+(mark&&entry?signed((mark-entry)/entry*100)+'%':'—')),el('span','','現價 '+price(mark)));pnlRow.append(pnlBlock,quoteBlock);card.append(pnlRow);
    const ladder=el('div','tg-ladder');
    function level(label,value,{kind='',note='',hit=false}={}){const row=el('div','tg-level '+kind+(hit?' is-hit':''));row.append(el('span','tg-level-label',label),el('i','tg-level-rule'),el('strong','tg-level-price',price(value)),el('span','tg-level-note',hit?'✓':note));ladder.append(row);}
    for(let i=3;i>=0;i--){const target=Array.isArray(t.targets)&&typeof t.targets[i]==='object'?t.targets[i]:null;level('TP'+(i+1),targets[i],{kind:'tg-target',note:watch?'—':target?.status==='STOPPED'?'已結束':[20,30,30,20][i]+'%',hit:target?.status==='HIT'});}
    level('進場',entry,{kind:'tg-entry',note:t.openedAt?'●':watch?'—':'待成交'});
    if(t.exitGuard&&t.status==='OPEN')level('保護',t.exitGuard.price,{kind:'tg-guard',note:'回撤全出'});
    level('SL',t.stopLoss,{kind:'tg-stop',note:t.quantity?'剩餘 '+Math.round((t.remainingQuantity??t.quantity)/t.quantity*100)+'%':watch?'—':'原停損'});card.append(ladder);
    const events=[];
    if(t.openedAt)events.push({at:t.openedAt,label:'已進場',detail:price(t.entry),kind:'entry'});
    for(const f of t.exitFills||[])events.push({at:f.at,label:/^TP/.test(f.label)?f.label+' 觸及':f.label.startsWith('RETRACE_')?'回撤出場':'停損出場',detail:price(f.price)+' · 出場 '+price(f.quantity),kind:/^TP/.test(f.label)?'hit':'exit'});
    if(t.exitGuard&&t.status==='OPEN')events.push({at:t.exitGuard.activatedAt,label:'回撤保護設於 '+price(t.exitGuard.price),detail:t.exitGuard.label+' · 剩餘部位回撤全出',kind:'guard'});
    const timeline=el('div','tg-timeline');
    for(const e of events.sort((a,b)=>a.at-b.at).slice(-4)){const row=el('div','tg-event '+e.kind);row.append(el('i','tg-event-dot'),el('strong','',e.label),el('small','',date(e.at)+' · '+e.detail));timeline.append(row);}
    if(!events.length)timeline.append(el('p','tg-wait',watch?'4H與15M MACD同向，先列候選；等待15M回調結構確認':t.reason||plan?.reason||'等待新成交觸價'));
    const bottom=el('footer','tg-bottom'),details=el('details','tg-details');details.append(el('summary','','詳細資訊'));
    details.append(el('p','',t.recovery?.pending?(t.recovery.lastError||'正在核對中斷期間成交'):t.reason||plan?.reason||'未取得風控預留'));
    if(t.fib?.lowMacd)details.append(el('p','','4H DIF '+price((t.fib.highMacd||t.fib.trend).dif)+' / 訊號線 '+price((t.fib.highMacd||t.fib.trend).signal)+'；15M DIF '+price(t.fib.lowMacd.dif)+' / 訊號線 '+price(t.fib.lowMacd.signal)));
    const quantity=t.quantity??t.reservedPlan?.quantity??plan?.quantity,risk=t.estimatedStopRisk??t.reservedPlan?.risk??plan?.risk;
    if(finite(quantity))details.append(el('p','','原始數量 '+price(quantity)+' · 停損風險估算 '+price(risk)+' USDT'));
    if(finite(pct))details.append(el('p','','百分比為費後損益÷初始名目部位，包含已分批實現損益，不是槓桿保證金ROI。'));
    const copy=el('button','tg-copy','複製摘要');copy.type='button';copy.addEventListener('click',async()=>{const text=[t.symbol+' '+(long?'做多':'做空')+' · '+state,strategy+' · '+(t.timeframeLabel||'4H＋15M'),'進場 '+price(entry)+' · SL '+price(t.stopLoss),...targets.map((p,i)=>'TP'+(i+1)+' '+price(p)),finite(pnl)?'費後損益 '+signed(pnl)+' USDT':'尚未成交'].join('\n');try{await navigator.clipboard.writeText(text);copy.textContent='已複製';}catch{details.open=true;const area=el('textarea','tg-copy-text');area.value=text;area.readOnly=true;details.append(area);area.select();copy.textContent='請複製文字';}});bottom.append(details,copy);card.append(timeline,bottom);return card;
  }
  function paper(container,trades,model,now){const open=new Set([...container.querySelectorAll('details[open]')].map(d=>d.closest('[data-key]')?.dataset.key));container.replaceChildren();if(!trades.length){container.append(el('p','tg-empty','此篩選下尚無交易紀錄。'));return;}for(const group of (window.MarketGroups?window.MarketGroups.split(trades):[{items:trades}])){if(window.MarketGroups)container.append(window.MarketGroups.heading(group));for(const t of group.items){const pnl=['TAKE_PROFIT','STOP_LOSS'].includes(t.status)?t.netPnl:t.status==='OPEN'&&!t.recovery?.pending&&finite(t.lastPrice)?model.netAt(t,t.lastPrice).net:null;const card=render(t,{pnl,now});if(open.has(card.dataset.key))card.querySelector('details').open=true;container.append(card);}}}
  window.TradeCards={render,paper};
})();
