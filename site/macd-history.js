(function(){
  'use strict';
  const $=id=>document.getElementById(id),cache=new Map(),money=n=>Number.isFinite(n)?n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}):'—';
  const el=(tag,text)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;return n;},tone=(n,v)=>n.dataset.tone=v>0?'positive':v<0?'negative':'neutral';
  const time=n=>n?new Date(n).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false}):'—';let requested=0,index=null,selected="2026-08",worker=null,preparing=false,job=0;
  const db=new Promise((resolve,reject)=>{const r=indexedDB.open("codex-manual-backtests",1);r.onupgradeneeded=()=>r.result.createObjectStore("reports");r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  async function saved(month,value){const database=await db;return new Promise((resolve,reject)=>{const tx=database.transaction("reports",value?"readwrite":"readonly"),store=tx.objectStore("reports"),key=window.MacdStrategy.VERSION+":"+month,req=value?store.put(value,key):store.get(key);let result;req.onsuccess=()=>{result=req.result;};tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);});}
  db.catch(()=>{});
  const monthName=m=>Number(m.slice(5))+' 月',price=n=>Number.isFinite(n)?n.toLocaleString('en-US',{maximumSignificantDigits:9}):'—';
  async function json(url){const response=await fetch(url);if(!response.ok)throw Error('HTTP '+response.status);return response.json();}
  function clear(){for(const id of ['quarterSummary','quarterAssumptions','quarterAccount','quarterProfiles','quarterTargets','quarterTrades'])$(id).replaceChildren();$('quarterScope').textContent='';}
  async function load(month){
    selected=month;const token=++requested;clear();$('quarterStatus').textContent='載入 '+monthName(month)+' MACD回測…';
    document.querySelectorAll('[data-month]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.month===month)));
    try{
      const meta=index.months.find(r=>r.month===month);if(!meta)throw Error('找不到月份');
      if(!cache.has(month)){const r=await saved(month).catch(()=>null);if(r?.strategyVersion===window.MacdStrategy.VERSION)cache.set(month,r);}
      if(token!==requested)return;
      if(!cache.has(month)){$('quarterStatus').textContent=month+'：新策略尚未回測，請按「更新回測」。';return;}
      if(token!==requested)return;const r=cache.get(month);
      $('quarterStatus').textContent=r.month+' · '+time(r.start)+' 至 '+time(r.end-1)+' · 獨立起算 200 USDT';
      window.TargetView.paperSummary($('quarterSummary'),{account:r.account,stats:r.stats,trades:r.trades});
      $('quarterScope').textContent=r.scope+' 樣本排名時間：'+time(r.rankingAsOf)+'。';
      $('quarterAssumptions').replaceChildren(...r.assumptions.map(s=>el('li',s)),el('li','有路徑歧義的5M執行K：'+r.ambiguousBars+'；未取得預留的候選：'+r.blockedCandidates+'。'),el('li','行情覆蓋：'+r.coverage.map(c=>c.symbol+' '+c.percent.toFixed(1)+'%').join('、')));
      const values=[['初始資金','200.00 USDT'],['期末淨值',money(r.account.equity)+' USDT'],['期末餘額',money(r.account.balance)+' USDT'],['月度淨損益',money(r.account.periodPnl)+' USDT'],['最大淨值回撤',money(r.maxDrawdownPct)+'%'],['月末持倉／待成交',r.stats.open+' / '+r.stats.waiting],['進場確認訊號',r.signals+' 筆'],['因成本／風控未預留',r.blockedCandidates+' 筆']];
      $('quarterAccount').replaceChildren(...values.map(([label,value])=>{const box=el('div');box.append(el('span',label),el('strong',value));return box;}));
      $('quarterProfiles').replaceChildren(...Object.entries(r.profiles).map(([id,s])=>{const tr=el('tr');for(const v of [window.MacdStrategy.PROFILES[id].label,s.closed,s.winRate==null?'—':money(s.winRate)+'%',money(s.netPnl)+' USDT'])tr.append(el('td',v));tone(tr.lastChild,s.netPnl);return tr;}));
      window.TargetView.stats($('quarterTargets'),r.trades,{targetMode:'FIB'});
      const labels={TAKE_PROFIT:'四段止盈',STOP_LOSS:'停損',OPEN:'月末持倉',WAITING_PRICE:'月末待成交',SKIPPED:'取消',REVIEW:'待核對'};
      const trades=r.trades.filter(t=>t.entry>0).sort((a,b)=>b.openedAt-a.openedAt).map(t=>{const tr=el('tr'),status=t.exitReason?.startsWith('RETRACE_')?'回撤 '+t.exitReason.slice(8)+' 出場':labels[t.status]||t.status;for(const v of [t.symbol+' · '+t.timeframeLabel,time(t.openedAt),t.direction==='LONG'?'多':'空',price(t.entry),price(t.stopLoss),status,money(t.netPnl)])tr.append(el('td',v));tone(tr.lastChild,t.netPnl);tr.title=(t.exitFills||[]).map(f=>f.label+' '+f.quantity+' @ '+f.price).join('；');return tr;});
      if(!trades.length){const tr=el('tr'),td=el('td','此月沒有成交樣本');td.colSpan=7;tr.append(td);trades.push(tr);}$('quarterTrades').replaceChildren(...trades);
    }catch(e){if(token===requested)$('quarterStatus').textContent='回測報告無法載入：'+e.message;}
  }

  function comparison(){ $('monthlyComparison').replaceChildren(...index.months.map(m=>{const r=cache.get(m.month),tr=el('tr');for(const v of [monthName(m.month),r?money(r.account.returnPct)+'%':'待更新',r?money(r.account.periodPnl):'—',r?.stats.winRate!=null?money(r.stats.winRate)+'%':'—',r?r.stats.closed:'—',r?money(r.maxDrawdownPct)+'%':'—'])tr.append(el('td',v));if(r){tone(tr.children[1],r.account.returnPct);tone(tr.children[2],r.account.periodPnl);}return tr;})); }
  function controls(busy){$('monthUpdate').disabled=busy;$('monthCancel').hidden=!busy;document.querySelectorAll('[data-month]').forEach(b=>b.disabled=busy);}
  function stop(){job++;preparing=false;worker?.terminate();worker=null;controls(false);}
  $('monthCancel').addEventListener('click',()=>{stop();$('quarterStatus').textContent='已取消本次回測，未覆寫結果。';});
  $('monthUpdate').addEventListener('click',async()=>{if(worker||preparing)return;preparing=true;const currentJob=++job,month=selected;controls(true);$('quarterStatus').textContent='準備下載所選月份歷史行情…';try{
    if(!window.Worker)throw Error('此瀏覽器不支援背景回測');const universe=await json('research/macd-universe.json');if(currentJob!==job)return;preparing=false;worker=new Worker('month-backtest-worker.js?v=body-2');worker.onerror=e=>{stop();$('quarterStatus').textContent='回測失敗：'+e.message;};
    worker.onmessage=async e=>{const m=e.data;if(m.type==='progress'){$('quarterStatus').textContent=m.text;return;}if(m.type==='error'){stop();$('quarterStatus').textContent='回測失敗：'+m.text;return;}if(m.type==='done'){const r=m.report;if(r.strategyVersion!==window.MacdStrategy.VERSION||r.month!==month){stop();$('quarterStatus').textContent='回測版本不符，未保存';return;}let warning='';try{await saved(month,r);}catch{warning='；本機儲存失敗，關閉頁面後此結果會遺失';}cache.set(month,r);stop();comparison();await load(month);$('quarterStatus').textContent+=' · 已手動更新'+warning;}};
    worker.postMessage({month,universe});
  }catch(e){stop();$('quarterStatus').textContent='回測失敗：'+e.message;}});
  window.addEventListener('pagehide',()=>stop());
  async function init(){index={months:['2026-08','2026-09','2026-10'].map(month=>({month}))};for(const m of index.months){const r=await saved(m.month).catch(()=>null);if(r?.strategyVersion===window.MacdStrategy.VERSION)cache.set(m.month,r);}comparison();document.querySelectorAll('[data-month]').forEach(b=>b.addEventListener('click',()=>load(b.dataset.month)));await load('2026-08');}
  init();
})();
