(function(){
 'use strict';
 const M=window.MacdStrategy,$=id=>document.getElementById(id),client=window.StrategyData.createClient(),records=window.CandidateRecords.create(localStorage),KEY='codex-macd-fib-watch-v1',list=$('strategyList');
 let watches=[],latest=[],busy=false,nextAt=0,offset=0,controller=null;
 try{const saved=JSON.parse(localStorage.getItem(KEY));if(saved?.version===M.VERSION&&Array.isArray(saved.rows))watches=saved.rows.filter(o=>/^[A-Z0-9]+USDT$/.test(o.symbol)&&['LONG','SHORT'].includes(o.direction));}catch{}
 $('timeframeFilter').hidden=true;$('rsiEntryFilter').closest('label').hidden=true;
 function render(){const filter=$('directionFilter').value,rows=records.list().filter(r=>M.isVersion(r.candidate.strategyVersion)),plans=window.PaperTrading?.previewCandidates(latest,100)||new Map(),seen=new Set(),items=[];
  const addCandidate=(c,retained=false)=>{const key=window.PaperEngine.key(c);if(seen.has(key))return;seen.add(key);const snapshot=window.PaperTrading?.cardSnapshot(c),plan=plans.get(key),o=watches.find(o=>o.symbol===c.symbol),data=snapshot||{...c,id:key,entry:undefined,referenceEntry:c.entry,targets:undefined,plannedTargets:c.targets,status:'NOT_ENTERED',reason:plan?.reason||(c.expiresAt<=Date.now()+offset?'掛單已到期，未補成交':'等待帳戶預留')};if(o)data.macdDivergence=o.divergence;items.push({type:'plan',data,c,plan,pnl:snapshot?.cardPnl,retained,direction:c.direction,contractType:c.market.contractType});};
  for (const o of watches) {
    const saved = rows.map(r => r.candidate).filter(c => c.symbol === o.symbol);
    const current = latest.find(c => c.symbol === o.symbol) ||
      saved.find(c => ['OPEN', 'WAITING_PRICE', 'REVIEW'].includes(window.PaperTrading?.recordStatus(c)?.status));
    if (current) {
      addCandidate(current);
      continue;
    }
    const previous = saved.find(c => c.direction === o.direction);
    const data = previous ? {
      ...o, referenceEntry: previous.entry, stopLoss: previous.stopLoss,
      plannedTargets: previous.targets, previousLevels: true
    } : o;
    items.push({type:'watch',data,direction:o.direction,contractType:o.contractType});
  }
  for(const r of rows)addCandidate(r.candidate,true);
  const statusFilter = $('scannerStatusFilter').value;
  const visible = items.filter(item => {
    if (filter !== 'all' && item.direction !== filter) return false;
    const status = item.data.status;
    if (statusFilter === 'all') return true;
    if (statusFilter === 'active') {
      return item.type === 'watch' || ['WAITING_PRICE', 'OPEN', 'REVIEW'].includes(status) ||
        (status === 'NOT_ENTERED' && !item.retained);
    }
    if (statusFilter === 'closed') return ['TAKE_PROFIT', 'STOP_LOSS', 'TIME_EXIT'].includes(status);
    return item.type === 'plan' && status === statusFilter;
  });
 list.replaceChildren();$('candidateCount').textContent='('+visible.length+' 筆)';window.DashboardUI?.setCandidates(visible.length);$('candidateRecordStatus').textContent=records.getError()?'儲存失敗：'+records.getError():'';
  if(!visible.length){const p=document.createElement('p');p.className='strategy-empty';p.textContent=busy?'正在檢查4H MACD方向':'目前沒有符合篩選條件的卡片';list.append(p);}
  for(const group of window.MarketGroups.split(visible)){list.append(window.MarketGroups.heading(group));for(const row of group.items)list.append(window.TradeCards.compact(row.data));}
 }
 async function run(){if(busy)return;busy=true;controller=new AbortController();$('refreshBtn').disabled=true;window.PaperTrading?.beginScan();list.setAttribute('aria-busy','true');render();try{const r=await client.scan({capital:100,signal:controller.signal,onProgress(s){offset=s.serverOffset;$('scannerStatus').textContent='掃描中';$('scanProgress').textContent='合併成交額Top20 · '+s.completed+' / '+s.total+' · 方向候選 '+s.trending+' · 可掛單 '+s.candidates.length;$('scanMeter').max=s.total;$('scanMeter').value=s.completed;}});
  watches=r.observations.filter(o=>o.direction&&o.status!=='ERROR');latest=r.candidates.filter(c=>M.valid(c)&&c.expiresAt>r.asOf);try{localStorage.setItem(KEY,JSON.stringify({version:M.VERSION,rows:watches,at:r.asOf}));}catch{}records.update(latest,r.asOf);window.dispatchEvent(new Event('candidate-records-update'));window.PaperTrading?.updateMarketContext(r.observations);window.PaperTrading?.reconcileCandidates(latest,r.observations,r.asOf);window.PaperTrading?.acceptCandidates(latest,100,r.asOf,true);
  const symbols=[...new Set([...watches.map(o=>o.symbol),...(window.PaperTrading?.marketSymbols()||[])])];window.CatPriceFeed?.setScannerSymbols(symbols);window.dispatchEvent(new CustomEvent('strategy-scan-complete',{detail:{symbols,at:r.asOf}}));$('scannerStatus').textContent=r.errors?'完成 · 部分資料不可用':'掃描完成';$('lastUpdate').textContent='更新於 '+new Date(r.asOf).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false});nextAt=Math.floor(r.asOf/300000+1)*300000+3000;
 }catch(error){latest=[];window.PaperTrading?.invalidatePending('掃描中斷，取消未成交掛單');$('scannerStatus').textContent='掃描失敗';$('scanProgress').textContent=error.message;nextAt=Math.max(error.retryAt||0,Date.now()+60000)+offset;}finally{busy=false;controller=null;$('refreshBtn').disabled=false;list.setAttribute('aria-busy','false');render();}}
 $('refreshBtn').addEventListener('click',()=>{if(Date.now()>=client.getBackoffUntil())void run();});$('directionFilter').addEventListener('change',render);$('scannerStatusFilter').addEventListener('change',render);window.CatPriceFeed?.subscribe(render);window.addEventListener('paper-account-update',render);window.addEventListener('paper-records-cleared',()=>{records.clear();latest=[];render();});window.addEventListener('pagehide',()=>controller?.abort());setInterval(()=>{if(document.visibilityState!=='hidden'&&!busy&&navigator.onLine!==false&&Date.now()+offset>=nextAt)void run();},1000);void run();
})();
