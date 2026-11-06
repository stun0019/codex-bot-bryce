(function () {
  'use strict';
  const M=window.MacdStrategy,client=window.StrategyData.createClient(),$=id=>document.getElementById(id);
  const list=$('strategyList'),directionFilter=$('directionFilter'),refresh=$('refreshBtn');
  const records=window.CandidateRecords.create(localStorage);
  let latest=[],busy=false,nextScanAt=0,offset=0,controller=null;
  $('rsiEntryFilter').closest('label').hidden=true;
  $('timeframeFilter').hidden=true;
  function render(){
    const open=new Set([...list.querySelectorAll('article details[open]')].map(d=>d.closest('article').dataset.key));
    const rows=records.list().filter(r=>M.isVersion(r.candidate.strategyVersion)).filter(r=>directionFilter.value==='all'||r.candidate.direction===directionFilter.value);
    const plans=window.PaperTrading?.previewCandidates(latest,100)||new Map(),keys=new Set(latest.map(window.PaperEngine.key));
    list.replaceChildren();$('candidateCount').textContent='('+rows.length+' 筆紀錄)';window.DashboardUI?.setCandidates(rows.length);
    $('candidateRecordStatus').textContent=records.getError()?'候選儲存失敗：'+records.getError():'訊號確認後自動模擬下單 · 此裝置瀏覽器保存';
    if(!rows.length){const p=document.createElement('p');p.className='strategy-empty';p.textContent=busy?'正在檢查4H趨勢與15M回調確認':'等待符合完整進場規則的新訊號';list.append(p);return;}
    for(const group of window.MarketGroups.split(rows.map(r=>({candidate:r.candidate,contractType:r.candidate.market.contractType})))){
      list.append(window.MarketGroups.heading(group));
      for(const row of group.items){const c=row.candidate,key=window.PaperEngine.key(c),snapshot=window.PaperTrading?.cardSnapshot(c),plan=plans.get(key);
        const data=snapshot||{...c,id:key,referenceEntry:c.entry,entry:undefined,targets:undefined,plannedTargets:c.targets,status:'NOT_ENTERED',reason:c.expiresAt<=Date.now()+offset?'訊號已到期，未補進場':plan?.reason||'等待模擬帳戶預留'};
        const card=window.TradeCards.render(data,{plan,pnl:snapshot?.cardPnl,retained:!keys.has(key),now:Date.now()+offset});if(open.has(card.dataset.key))card.querySelector('details').open=true;list.append(card);
      }
    }
  }
  async function run(){if(busy)return;busy=true;refresh.disabled=true;refresh.textContent='掃描中…';controller=new AbortController();window.PaperTrading?.beginScan();window.dispatchEvent(new Event('strategy-scan-start'));list.setAttribute('aria-busy','true');render();
    try{const result=await client.scan({capital:100,signal:controller.signal,onProgress(s){offset=s.serverOffset;const tradfi=s.rankedMarkets.filter(m=>m.contractType==='TRADIFI_PERPETUAL').length;$('scannerStatus').textContent='策略掃描中';$('scannerStatus').dataset.state='pending';$('scanProgress').textContent='合併成交額 Top20（加密 '+(s.rankedMarkets.length-tradfi)+'／TradFi '+tradfi+'）· '+s.completed+' / '+s.total+' · 進場訊號 '+s.candidates.length;$('scanMeter').max=s.total;$('scanMeter').value=s.completed;}});
      latest=result.candidates.filter(c=>M.valid(c)&&c.expiresAt>result.asOf);
      records.update(latest,result.asOf);window.dispatchEvent(new Event('candidate-records-update'));
      window.PaperTrading?.reconcileCandidates(latest,result.observations,result.asOf);
      window.PaperTrading?.acceptCandidates(latest,100,result.asOf,true);
      const symbols=[...new Set([...latest.map(c=>c.symbol),...(window.PaperTrading?.marketSymbols()||[])])];window.CatPriceFeed?.setScannerSymbols(symbols);
      window.dispatchEvent(new CustomEvent('strategy-scan-complete',{detail:{symbols,at:result.asOf}}));
      $('scannerStatus').textContent=result.errors?'掃描完成 · 部分商品資料不可用':'掃描完成';$('scannerStatus').dataset.state=result.errors?'partial':'live';$('lastUpdate').dateTime=new Date(result.asOf).toISOString();$('lastUpdate').textContent='更新於 '+new Date(result.asOf).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false});nextScanAt=Math.floor(result.asOf/300000+1)*300000+3000;
    }catch(error){latest=[];window.PaperTrading?.invalidatePending('掃描中斷，取消未成交計畫');$('scannerStatus').textContent='掃描失敗';$('scannerStatus').dataset.state='error';$('scanProgress').textContent=error.message;nextScanAt=Math.max(error.retryAt||0,Date.now()+60000)+offset;}
    finally{busy=false;controller=null;refresh.disabled=false;refresh.textContent='更新';list.setAttribute('aria-busy','false');render();}
  }
  directionFilter.addEventListener('change',render);refresh.addEventListener('click',()=>{if(Date.now()>=client.getBackoffUntil())void run();});window.CatPriceFeed?.subscribe(()=>{if(document.visibilityState!=='hidden')render();});window.addEventListener('paper-account-update',render);
  window.addEventListener('paper-records-cleared',()=>{records.clear();latest=[];render();});window.addEventListener('pagehide',()=>controller?.abort());
  setInterval(()=>{if(document.visibilityState!=='hidden'&&!busy&&Date.now()+offset>=nextScanAt&&navigator.onLine!==false)void run();},1000);void run();
})();
