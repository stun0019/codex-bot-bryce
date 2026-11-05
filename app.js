'use strict';
const $=id=>document.getElementById(id),money=n=>n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}),pct=n=>(n>=0?'+':'')+(n*100).toFixed(2)+'%';
// 策略參數僅在程式碼維護，頁面載入後自動計算。
const strategy=Object.freeze({capital:1000,fast:10,slow:30,fee:0.1,slip:0.05});
let result=null,activeRows=null;
const pnlClass=value=>value>0?'positive':value<0?'negative':'';
function download(name,text){const url=URL.createObjectURL(new Blob(['\uFEFF'+text],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function chart(r){const all=r.curve.concat(r.benchmark),min=Math.min(...all)*.98,max=Math.max(...all)*1.02,range=max-min||1;const x=i=>64+i/(r.curve.length-1)*720,y=n=>246-(n-min)/range*224;const path=arr=>arr.map((n,i)=>(i?'L':'M')+x(i).toFixed(2)+','+y(n).toFixed(2)).join(' ');let grid='';for(let i=0;i<5;i++){const n=min+range*i/4,yy=y(n);grid+=`<line x1="64" x2="784" y1="${yy}" y2="${yy}" stroke="#303030"/><text x="52" y="${yy+4}" fill="#999999" text-anchor="end" font-size="11">${n.toFixed(n<100?2:0)}</text>`;}
 $('chart').innerHTML=`${grid}<path d="${path(r.benchmark)}" fill="none" stroke="#777777" stroke-width="2" stroke-dasharray="5 5"/><path d="${path(r.curve)}" fill="none" stroke="#eeeeee" stroke-width="2.5"/>`;
}
function run(){try{const p=strategy,rows=Quant.demo();const r=Quant.backtest(rows,p);result=r;activeRows=rows;
 $('equity').textContent=money(r.ending);$('return').textContent=pct(r.returns);$('return').className=pnlClass(r.returns);$('drawdown').textContent='−'+(r.drawdown*100).toFixed(2)+'%';$('drawdown').className=r.drawdown>0?'negative':'';$('winrate').textContent=r.winrate===null?'—':(r.winrate*100).toFixed(1)+'%';$('benchmark').textContent='買入持有 '+pct(r.bhReturn);$('benchmark').className=pnlClass(r.bhReturn);$('tradecount').textContent=`${r.closed} 筆平倉 / ${r.trades.length} 次成交`;$('period').textContent=`${rows[0].date} — ${rows.at(-1).date} · ${rows.length} 筆`;$('startdate').textContent=rows[0].date;$('enddate').textContent=rows.at(-1).date;$('position').textContent=r.qty?`期末持倉 ${r.qty.toFixed(6)} 單位；最後收盤估值，未扣未來賣出成本。`:'期末空倉';
 $('trades').replaceChildren();if(!r.trades.length){$('trades').innerHTML='<tr><td colspan="5">這段期間沒有觸發成交。</td></tr>';}else for(const t of [...r.trades].reverse()){const tr=document.createElement('tr');[t.date,t.side==='buy'?'買入':'賣出',money(t.price),money(t.fee),t.pnl===null?'—':(t.pnl>=0?'+':'')+money(t.pnl)].forEach((value,i)=>{const td=document.createElement('td');td.textContent=value;if(i===1&&t.side==='buy')td.className='positive';if(i===4&&t.pnl!==null)td.className=t.pnlClass(pnl);tr.append(td);});$('trades').append(tr);}
 chart(r);renderMonitor(r,rows);$('error').textContent='';
 }catch(e){$('error').textContent=e.message+' 目前結果仍是上次成功的回測。';}}
$('export').addEventListener('click',()=>{if(!result)return;download('quant-trades.csv',`# start=${activeRows[0].date}; end=${activeRows.at(-1).date}\ndate,side,price,quantity,fee,realized_pnl\n`+result.trades.map(t=>[t.date,t.side,t.price,t.qty,t.fee,t.pnl??''].join(',')).join('\n'));});
run();

function renderMonitor(r,rows){
 const pnl=r.ending-strategy.capital,realized=r.trades.filter(t=>t.side==='sell').reduce((sum,t)=>sum+t.pnl,0);
 $('total-pnl').textContent=(pnl>=0?'+':'')+money(pnl);$('total-pnl').className=pnl>=0?'positive':'negative';
 $('strategy-winrate').textContent=r.winrate===null?'—':(r.winrate*100).toFixed(1)+'%';
 $('closed-count').textContent=r.closed+' 筆已平倉交易';
 $('realized-pnl').replaceChildren();for(const [i,label,value] of [[0,'已實現',realized],[1,'未實現',pnl-realized]]){const span=document.createElement('span');span.textContent=(i?' · ':'')+label+' '+(value>0?'+':'')+money(value)+' USDT';span.className=pnlClass(value);$('realized-pnl').append(span);}
 const closed=[];let entry=null;
 for(const trade of r.trades){if(trade.side==='buy')entry=trade;else if(entry){const held=rows.filter(row=>row.date>=entry.date&&row.date<=trade.date);closed.push({entry:entry.price,peak:Math.max(...held.map(row=>row.close))});entry=null;}}
 [2,3,4,5].forEach((rr,i)=>{const hits=closed.filter(t=>t.peak>=t.entry*(1+.02*rr)).length;$('tp'+(i+1)).textContent=closed.length?(hits/closed.length*100).toFixed(1)+'%':'—';$('tp'+(i+1)+'-count').textContent=hits+' / '+closed.length+' 筆平倉';});
 $('stats-period').textContent=rows[0].date+' — '+rows.at(-1).date;
}
function showPage(){const second=location.hash==='#page2';$('page1').hidden=second;$('page2').hidden=!second;for(const id of ['page1','page2']){const link=$('nav-'+id);if((id==='page2')===second)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');}document.title=(second?'PAGE 2｜策略監控':'Quant Pocket｜口袋量化');}
window.addEventListener('hashchange',showPage);showPage();
