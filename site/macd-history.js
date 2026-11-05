(function(){
  'use strict';
  const $=id=>document.getElementById(id),cache=new Map(),money=n=>Number.isFinite(n)?n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}):'—';
  const el=(tag,text)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;return n;},tone=(n,v)=>n.dataset.tone=v>0?'positive':v<0?'negative':'neutral';
  const time=n=>n?new Date(n).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false}):'—';let requested=0,index=null;
  const monthName=m=>Number(m.slice(5))+' 月',price=n=>Number.isFinite(n)?n.toLocaleString('en-US',{maximumSignificantDigits:9}):'—';
  async function json(url){const response=await fetch(url);if(!response.ok)throw Error('HTTP '+response.status);return response.json();}
  function clear(){for(const id of ['quarterSummary','quarterAssumptions','quarterAccount','quarterProfiles','quarterTargets','quarterTrades'])$(id).replaceChildren();$('quarterScope').textContent='';}
  async function load(month){
    const token=++requested;clear();$('quarterStatus').textContent='載入 '+monthName(month)+' MACD回測…';
    document.querySelectorAll('[data-month]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.month===month)));
    try{
      const meta=index.months.find(r=>r.month===month);if(!meta)throw Error('找不到月份');
      if(!cache.has(month)){const r=await json(meta.url);if(r.strategyVersion!==window.MacdStrategy.VERSION||r.month!==month||r.capital!==200||!Array.isArray(r.trades))throw Error('報告版本不符');cache.set(month,r);}
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
  async function init(){
    try{
      index=await json('research/macd-month-index.json');if(index.strategyVersion!==window.MacdStrategy.VERSION||!Array.isArray(index.months)||index.months.length!==3)throw Error('月報索引版本不符');
      $('monthlyComparison').replaceChildren(...index.months.map(r=>{const tr=el('tr');for(const v of [monthName(r.month),money(r.account.returnPct)+'%',money(r.account.periodPnl),r.stats.winRate==null?'—':money(r.stats.winRate)+'%',r.stats.closed,money(r.maxDrawdownPct)+'%'])tr.append(el('td',v));tone(tr.children[1],r.account.returnPct);tone(tr.children[2],r.account.periodPnl);return tr;}));
      document.querySelectorAll('[data-month]').forEach(b=>b.addEventListener('click',()=>load(b.dataset.month)));await load('2026-08');
    }catch(e){$('quarterStatus').textContent='回測報告無法載入：'+e.message;}
  }
  init();
})();
