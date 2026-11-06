(function(){
 'use strict';
 const $=id=>document.getElementById(id),el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;},money=n=>Number.isFinite(n)?n.toFixed(2):'—';let busy=false;
 document.querySelectorAll('[data-month]').forEach(b=>b.hidden=true);$('monthCancel').hidden=true;$('monthUpdate').textContent='重新載入初測';
 const time=t=>new Date(t).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false});
 async function load(){if(busy)return;busy=true;$('monthUpdate').disabled=true;$('quarterStatus').textContent='載入新版10筆歷史初測…';try{const response=await fetch('research/structure-initial.json?v='+window.MacdStrategy.VERSION,{cache:'no-store'});if(!response.ok)throw Error('HTTP '+response.status);const r=await response.json();if(r.strategyVersion!==window.MacdStrategy.VERSION)throw Error('報告版本不符');const s=r.summary;
  $('quarterStatus').textContent='10筆調整用歷史樣本 · 不代表未來勝率／即時績效';$('quarterScope').textContent=r.scope;
  $('quarterAssumptions').replaceChildren(...['本金100 USDT、單筆預估風險5%、同時一單、50x槓桿設定。','4H EMA50方向；15M RSI2恢復及價格確認。','15M已確認且未被突破的結構高低點止盈、停損2ATR，最長12小時／台北午夜平倉。','進出各0.05%費用、各0.02%滑價，計入實際資金費率。','歷史以5M開盤重播成交；即時模擬用60秒內下一筆聚合成交；資料曾用於調整，尚未有新樣本驗證。'].map(t=>el('li',t)));
  $('quarterSummary').replaceChildren();for(const[name,value]of[['費後報酬',money(s.returnPct)+'%'],['費後勝率',money(s.winRate)+'%'],['已平倉',s.closed+' 筆']]){const card=el('div',null,'paper-summary-card');card.append(el('span',name),el('strong',value));$('quarterSummary').append(card);}
  $('quarterAccount').replaceChildren();for(const[name,value]of[['初始資金',money(s.capital)],['期末資金',money(s.endEquity)],['淨損益',money(s.netPnl)],['最大回撤',money(s.maxDrawdownPct)+'%']]){const box=el('div');box.append(el('span',name),el('strong',value));$('quarterAccount').append(box);}
  $('monthlyComparison').replaceChildren();$('quarterProfiles').replaceChildren();const row=el('tr');for(const text of ['4H＋15M',s.closed,money(s.winRate)+'%',money(s.netPnl)+' USDT'])row.append(el('td',text));$('quarterProfiles').append(row);
  $('quarterTargets').replaceChildren(el('p','結構目標觸及 '+s.tp1Hits+' / '+s.closed+'；目標觸及率與費後勝率分開計算。','target-help'));
  $('quarterTrades').replaceChildren();for(const t of r.trades){const row=el('tr');for(const text of [t.symbol+' · 4H＋15M',time(t.openedAt),t.direction==='LONG'?'做多':'做空',t.entry,t.originalStop,t.reason,money(t.netPnl)])row.append(el('td',text));$('quarterTrades').append(row);}
 }catch(error){$('quarterStatus').textContent='初測報告載入失敗：'+error.message;}finally{busy=false;$('monthUpdate').disabled=false;}}
 $('monthUpdate').addEventListener('click',()=>void load());void load();
})();
