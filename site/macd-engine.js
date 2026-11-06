(function(root){
 'use strict';
 const E=root.StrategyEngine||(typeof require==='function'?require('./strategy-engine.js'):null),S=root.SmcEntry||(typeof require==='function'?require('./smc-entry.js'):null),VERSION=S.VERSION,LEVELS=[2],PROFILES={'4h15m':{id:'4h15m',label:'4H＋15M',high:'4h',low:'15m'}},clone=x=>JSON.parse(JSON.stringify(x));
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
  if(!PROFILES[id])throw Error('未知週期');const high=[],low=[],points=[],watch=new Map(),used=new Set(),broken=new Set();let bias=null,pending=null,lastDirection=null;
  function pushHigh(b){check(b,high.at(-1),14400000);high.push(clone(b));if(high.length>499)high.shift();bias=trend(high);}
  function pushLow(b,market){check(b,low.at(-1),900000);const prev=low.at(-1),at=b.closeTime+1,openDirection=lastDirection;low.push(clone(b));if(low.length>499)low.shift();const lm=trend(low),direction=bias?.direction&&lm?.direction===bias.direction?bias.direction:null;lastDirection=direction;let candidate=null;
   if(pending&&(at>=pending.expiresAt||pending.direction!==direction))pending=null;
   for(const [key,w] of watch){const long=w.direction==='LONG';if(at>=w.setupAt+21600000||direction!==w.direction||openDirection!==w.direction||(long?b.low<=w.stop:b.high>=w.stop)){watch.delete(key);continue;}
    if(!w.touch){if(long?b.low<=w.zone.high:b.high>=w.zone.low)w.touch=clone(b);else continue;}
    if(long?b.close>w.zone.high:b.close<w.zone.low){watch.delete(key);if(!pending){const entry=E.quantize(b.close,market.tickSize,long?'ceil':'floor'),f={...w,confirmation:clone(b),highMacd:clone(bias),lowMacd:clone(lm)},target=S.target(entry,w.stop,w.direction,market.tickSize);const c={symbol:market.symbol,direction:w.direction,strategyVersion:VERSION,strategyName:'MACD＋15M SMC',profileId:id,timeframeLabel:'4H＋15M',setupId:key,entryType:'MARKET_NEXT',targetMode:'SINGLE',targetCount:1,partialExit:false,riskFraction:.05,entry,stopLoss:w.stop,target,targets:[target],tickSize:market.tickSize,stepSize:market.stepSize,confirmedAt:at,expiresAt:Math.min(w.setupAt+21600000,at+900000),smcEntry:f,market:{...market},entryFilter:{enabled:false}};if(S.valid(c)){candidate=c;pending=clone(c);}}}
   }
   if(direction&&prev){const long=direction==='LONG',structure=points.filter(p=>p.side===(long?'HIGH':'LOW')&&p.confirmedAt<=b.openTime).at(-1),anchor=points.filter(p=>p.side===(long?'LOW':'HIGH')&&p.confirmedAt<=b.openTime).at(-1),breakKey=structure?direction+':'+structure.openTime:null;
    if(structure&&anchor&&!broken.has(breakKey)&&(long?prev.close<=structure.price&&b.close>structure.price:prev.close>=structure.price&&b.close<structure.price)){
     const leg=low.filter(x=>x.openTime>=anchor.openTime&&x.openTime<b.openTime),ob=leg.filter(x=>long?x.close<x.open:x.close>x.open).at(-1),key=ob?id+':'+direction+':'+ob.openTime:null;
     if(ob&&!used.has(key)){const z=S.zone(ob,market.tickSize),stop=E.quantize((long?z.low:z.high)+(long?-market.tickSize:market.tickSize),market.tickSize,long?'floor':'ceil');if(stop>0&&(long?b.close>z.high:b.close<z.low)){used.add(key);broken.add(breakKey);watch.set(key,{direction,ob:clone(ob),zone:z,stop,structure:clone(structure),swingAnchor:clone(anchor),legBars:clone(leg),bos:clone(b),previous:clone(prev),setupAt:at,setupHigh:clone(bias),setupLow:clone(lm),touch:null});}}
    }
   }
   points.push(...pivots(low));if(points.length>200)points.splice(0,points.length-200);
   return{candidate,pending:pending?clone(pending):null,status:pending?'WAIT_FILL':watch.size?'WAIT_OB_RETEST':direction?'WAIT_BOS':'NO_ALIGNMENT',reason:pending?'15M回踩OB收盤確認，等待下一筆報價':watch.size?'已確認15M結構突破，等待OB回踩收盤確認':direction?'MACD同向，等待15M結構突破':'等待4H與15M MACD同向',trend:bias,macdLow:lm,direction,entryFilter:{enabled:false}};
  }return{pushHigh,pushLow};
 }
 function analyze(market,higher,lower,asOf,capital=200,id='4h15m'){
  for(const [bars,d] of [[higher,14400000],[lower,900000]])if(!bars.length||bars.at(-1).closeTime!==Math.floor(asOf/d)*d-1)throw Error('需要最新已收盤K線');const a=createAnalyzer(id);let h=0,r={pending:null};for(const b of lower){while(h<higher.length&&higher[h].closeTime<=b.closeTime)a.pushHigh(higher[h++]);if(h)r=a.pushLow(b,market);}return r;
 }
 const api={MODE:'SMC_ENTRY',VERSION,LEVELS,PROFILES,trend,createAnalyzer,analyze,single:S.isSingle,valid:S.valid,prices:(f,d,t)=>{const entry=E.quantize(f.confirmation.close,t,d==='LONG'?'ceil':'floor');return S.planAt({stopLoss:f.stop,direction:d,tickSize:t},entry);},isVersion:v=>v===VERSION};
 if(typeof module!=='undefined'&&module.exports)module.exports=api;root.MacdStrategy=api;
})(typeof window!=='undefined'?window:globalThis);
