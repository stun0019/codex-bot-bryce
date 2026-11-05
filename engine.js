(function(root){
 'use strict';
 function demo(){let price=28000,seed=42;return Array.from({length:365},(_,i)=>{seed=(seed*1664525+1013904223)>>>0;price*=Math.exp(.001+Math.sin(i/24)*.009+(seed/4294967296-.5)*.045);return{date:new Date(Date.UTC(2025,0,1+i)).toISOString().slice(0,10),close:Math.round(price*100)/100};});}
 function parseCSV(text){
  const lines=text.replace(/^\uFEFF/,'').trim().split(/\r?\n/).filter(x=>x.trim());
  if(lines.length<4)throw Error('至少需要 3 筆價格及一行欄位名稱。');
  if(lines.length>20001)throw Error('最多支援 20,000 筆價格。');
  const split=line=>line.split(',').map(x=>x.trim().replace(/^"(.*)"$/,'$1'));
  const headers=split(lines.shift()).map(x=>x.toLowerCase()),di=headers.indexOf('date'),ci=headers.indexOf('close');
  if(di<0||ci<0)throw Error('CSV 欄位必須包含 date 與 close。');
  const rows=lines.map((line,i)=>{const cols=split(line),date=cols[di],close=Number(cols[ci]);const time=Date.parse(date+'T00:00:00Z');if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(time)||new Date(time).toISOString().slice(0,10)!==date||!Number.isFinite(close)||close<=0)throw Error(`第 ${i+2} 行的日期或價格無效。日期格式為 YYYY-MM-DD，價格須大於 0。`);return{date,close};}).sort((a,b)=>a.date.localeCompare(b.date));
  if(rows.some((r,i)=>i&&r.date===rows[i-1].date))throw Error('日期不可重複，請每個日期保留一筆價格。');
  return rows;
 }
 function backtest(rows,p){
  const {capital,fast,slow,fee,slip}=p;
  if(!Number.isFinite(capital)||capital<1||capital>1e9||!Number.isInteger(fast)||!Number.isInteger(slow)||fast<2||fast>=slow||slow>500||!Number.isFinite(fee)||fee<0||fee>5||!Number.isFinite(slip)||slip<0||slip>5)throw Error('請輸入有效參數；短均線須小於長均線，長均線最多 500 天。');
  if(rows.length<slow+2)throw Error(`資料不足，長均線 ${slow} 天至少需要 ${slow+2} 筆價格。`);
  const f=fee/100,s=slip/100,trades=[],curve=[],benchmark=[];let cash=capital,qty=0,basis=0,pending=null,prev=null,fs=0,ss=0,peak=capital,drawdown=0;
  const bhQty=capital/(rows[0].close*(1+s)*(1+f));
  rows.forEach((r,i)=>{
   if(pending==='buy'&&qty===0){const price=r.close*(1+s);qty=cash/(price*(1+f));const cost=qty*price;basis=cash;trades.push({date:r.date,side:'buy',price,fee:cost*f,pnl:null,qty});cash=0;}
   if(pending==='sell'&&qty>0){const price=r.close*(1-s),gross=qty*price,cost=gross*f;cash=gross-cost;trades.push({date:r.date,side:'sell',price,fee:cost,pnl:cash-basis,qty});qty=0;basis=0;}
   pending=null;
   const value=cash+qty*r.close;curve.push(value);benchmark.push(bhQty*r.close);peak=Math.max(peak,value);drawdown=Math.max(drawdown,(peak-value)/peak);
   fs+=r.close;ss+=r.close;if(i>=fast)fs-=rows[i-fast].close;if(i>=slow)ss-=rows[i-slow].close;
   if(i>=slow-1){const positive=fs/fast>ss/slow;if(prev!==null&&positive!==prev){if(positive&&qty===0)pending='buy';if(!positive&&qty>0)pending='sell';}prev=positive;}
  });
  const closed=trades.filter(t=>t.side==='sell');return{curve,benchmark,trades,drawdown,qty,cash,ending:curve.at(-1),returns:curve.at(-1)/capital-1,bhReturn:benchmark.at(-1)/capital-1,winrate:closed.length?closed.filter(t=>t.pnl>0).length/closed.length:null,closed:closed.length};
 }
 const api={demo,parseCSV,backtest};if(typeof module!=='undefined')module.exports=api;else root.Quant=api;
})(typeof window==='undefined'?globalThis:window);
