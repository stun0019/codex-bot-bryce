(function(){
  "use strict";
  const $=id=>document.getElementById(id),cache=new Map(),money=n=>Number.isFinite(n)?n.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2}):"—";
  let requested=0;
  const el=(tag,text)=>{const node=document.createElement(tag);if(text!=null)node.textContent=text;return node;};
  const time=at=>at?new Date(at).toLocaleString("zh-TW",{timeZone:"Asia/Taipei",hour12:false}):"—";
  const tone=(node,value)=>node.dataset.tone=value>0?"positive":value<0?"negative":"neutral";
  async function load(q){
    const token=++requested;$('quarterStatus').textContent="載入2026 Q"+q+"回測報告…";
    document.querySelectorAll('[data-quarter]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.quarter===String(q))));
    for(const id of ['quarterSummary','quarterAssumptions','quarterAccount','quarterProfiles','quarterTargets','quarterTrades'])$(id).replaceChildren();$('quarterScope').textContent='';
    try{
      if(!cache.has(q)){const response=await fetch("research/fib-2026-q"+q+".json");if(!response.ok)throw Error("HTTP "+response.status);const value=await response.json();if(value.strategyVersion!==window.FibEngine.VERSION||value.quarter!=="2026 Q"+q||!Array.isArray(value.trades))throw Error("報告版本不符");cache.set(q,value);}
      if(token!==requested)return;const r=cache.get(q);
      $('quarterStatus').textContent=r.quarter+" · "+time(r.start)+" 至 "+time(r.end-1)+" · 每季獨立200 USDT";
      window.TargetView.paperSummary($('quarterSummary'),{account:r.account,stats:r.stats,trades:r.trades});
      $('quarterScope').textContent=r.scope+" 樣本排名時間："+time(r.rankingAsOf)+"。RSI＋放量額外過濾：關閉。";
      $('quarterAssumptions').replaceChildren(...r.assumptions.map(a=>el('li',a)),el('li',"OHLC路徑有歧義的執行K："+r.ambiguousBars+"；因風控／成本未取得預留的候選："+r.blockedCandidates+"。"),el('li',"各幣執行行情覆蓋："+r.coverage.map(c=>c.symbol+" "+c.percent.toFixed(1)+"%").join('、')));
      const values=[["期末餘額",money(r.account.balance)+" USDT"],["期末淨值",money(r.account.equity)+" USDT"],["淨值最大回撤",money(r.maxDrawdownPct)+"%"],["季末持倉／待成交",r.stats.open+" / "+r.stats.waiting],["已平倉淨損益",money(r.stats.netPnl)+" USDT"],["結構候選",r.signals+" 筆"]];
      $('quarterAccount').replaceChildren(...values.map(([label,value])=>{const box=el('div');box.append(el('span',label),el('strong',value));return box;}));
      $('quarterProfiles').replaceChildren(...Object.entries(r.profiles).map(([id,s])=>{const row=el('tr');for(const v of [window.FibEngine.PROFILES[id].label,s.closed,s.winRate==null?'—':money(s.winRate)+'%',money(s.netPnl)+' USDT'])row.append(el('td',v));tone(row.lastChild,s.netPnl);return row;}));
      window.TargetView.stats($('quarterTargets'),r.trades,{targetMode:'FIB'});
      const labels={TAKE_PROFIT:'四段止盈',STOP_LOSS:'停損',OPEN:'季末持倉',WAITING_PRICE:'季末待成交',SKIPPED:'取消／略過',REVIEW:'行情待核對'};
      const rows=r.trades.filter(t=>t.entry>0).sort((a,b)=>b.openedAt-a.openedAt).map(t=>{const row=el('tr');for(const v of [t.symbol+' · '+t.timeframeLabel,time(t.openedAt),t.direction==='LONG'?'多':'空',t.exitReason?.startsWith('RETRACE_')?'回撤 '+t.exitReason.slice(8)+' 出場':labels[t.status]||t.status,money(t.netPnl)])row.append(el('td',v));tone(row.lastChild,t.netPnl);return row;});
      if(!rows.length){const row=el('tr'),cell=el('td','此季沒有符合條件且成交的交易');cell.colSpan=5;row.append(cell);rows.push(row);}$('quarterTrades').replaceChildren(...rows);
    }catch(error){if(token===requested)$('quarterStatus').textContent="回測報告暫時無法載入："+error.message;}
  }
  document.querySelectorAll('[data-quarter]').forEach(button=>button.addEventListener('click',()=>load(Number(button.dataset.quarter))));load(1);
})();
