(function(root){
 'use strict';
 const E=root.StrategyEngine||(typeof require==='function'?require('./strategy-engine.js'):null),VERSION='macd-watch-m15-levels-v1',PROFILES={'4h15m':{id:'4h15m',label:'4H＋15M',high:'4h',low:'15m'}},clone=x=>JSON.parse(JSON.stringify(x));
  function trend(bars){
    if(bars.length<35)return null;
    const c=bars.slice(-499).map(b=>b.close);let fast=c.slice(0,12).reduce((a,b)=>a+b,0)/12,slow=c.slice(0,26).reduce((a,b)=>a+b,0)/26;
    for(let i=12;i<26;i++)fast+=(c[i]-fast)*2/13;
    const difs=[fast-slow];for(let i=26;i<c.length;i++){fast+=(c[i]-fast)*2/13;slow+=(c[i]-slow)*2/27;difs.push(fast-slow);}
    let signal=difs.slice(0,9).reduce((a,b)=>a+b,0)/9;for(let i=9;i<difs.length;i++)signal+=(difs[i]-signal)*2/10;
    const dif=difs.at(-1);return {dif,signal,histogram:dif-signal,direction:dif>0&&signal>0?'LONG':dif<0&&signal<0?'SHORT':null,at:bars.at(-1).closeTime+1};
  }
  function check(b,prev,d){
    if(!b||![b.openTime,b.closeTime,b.open,b.high,b.low,b.close,b.volume].every(Number.isFinite)||b.openTime%d||b.closeTime!==b.openTime+d-1||b.low<=0||b.volume<0||b.low>Math.min(b.open,b.close)||b.high<Math.max(b.open,b.close)||b.high<b.low||(prev&&b.openTime!==prev.openTime+d))throw Error('K 線不連續或格式錯誤');
  }
  function pivots(bars){
    if(bars.length<5)return [];
    const b=bars.at(-3),near=[bars.at(-5),bars.at(-4),bars.at(-2),bars.at(-1)],out=[];
    if(near.every(x=>x.high<b.high))out.push({side:'HIGH',price:b.high,bar:clone(b),openTime:b.openTime,confirmedAt:bars.at(-1).closeTime+1});
    if(near.every(x=>x.low>b.low))out.push({side:'LOW',price:b.low,bar:clone(b),openTime:b.openTime,confirmedAt:bars.at(-1).closeTime+1});
    return out;
  }


 function createAnalyzer(id='4h15m'){
  if(!PROFILES[id])throw Error('未知週期');const high=[],low=[];let bias=null,recentHigh=null,recentLow=null;
  function pushHigh(b){check(b,high.at(-1),14400000);high.push(clone(b));if(high.length>499)high.shift();bias=trend(high);}
  function pushLow(b){check(b,low.at(-1),900000);low.push(clone(b));if(low.length>499)low.shift();for(const p of pivots(low)){if(p.side==='HIGH')recentHigh=p;else recentLow=p;}if(recentHigh&&recentHigh.openTime<low[0].openTime)recentHigh=null;if(recentLow&&recentLow.openTime<low[0].openTime)recentLow=null;const lm=trend(low),direction=bias?.direction&&lm?.direction===bias.direction?bias.direction:null;
   return{candidate:null,pending:null,status:direction?'WATCH':'NO_ALIGNMENT',reason:direction?'MACD同向候選，進場由你自行判斷':'等待4H與15M MACD同向',trend:bias,macdLow:lm,direction,recentHigh:recentHigh?clone(recentHigh):null,recentLow:recentLow?clone(recentLow):null,lastClose:b.close,confirmedAt:b.closeTime+1,entryFilter:{enabled:false}};
  }return{pushHigh,pushLow};
 }
 function analyze(market,higher,lower,asOf,capital=200,id='4h15m'){
  for(const [bars,d] of [[higher,14400000],[lower,900000]])if(!bars.length||bars.at(-1).closeTime!==Math.floor(asOf/d)*d-1)throw Error('需要最新已收盤K線');const a=createAnalyzer(id);let h=0,r={pending:null};for(const b of lower){while(h<higher.length&&higher[h].closeTime<=b.closeTime)a.pushHigh(higher[h++]);if(h)r=a.pushLow(b);}return r;
 }
 const api={MODE:'CANDIDATES_ONLY',VERSION,PROFILES,trend,createAnalyzer,analyze,valid:()=>false,isVersion:v=>v===VERSION};if(typeof module!=='undefined'&&module.exports)module.exports=api;root.MacdStrategy=api;
})(typeof window!=='undefined'?window:globalThis);
