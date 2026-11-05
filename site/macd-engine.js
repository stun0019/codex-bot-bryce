(function(root){
  'use strict';
  const E=root.StrategyEngine||(typeof require==='function'?require('./strategy-engine.js'):null);
  const VERSION='macd-pullback-break-4h15m-v4', LEVELS=[0,-.27,-.618,-1];
  const PROFILES={'4h15m':{id:'4h15m',label:'4H＋15M',high:'4h',low:'15m'}};
  const clone=x=>JSON.parse(JSON.stringify(x));
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
  function prices(f,direction,tick){
    const long=direction==='LONG',a=f.a.price,b=f.b.price,span=Math.abs(b-a);
    const entry=E.quantize(f.confirm.close,tick,long?'ceil':'floor');
    const stopLoss=E.quantize(f.pullbackExtreme,tick,long?'floor':'ceil')+(long?-tick:tick);
    const targets=LEVELS.map(l=>E.quantize(b+(long?1:-1)*(-l)*span,tick,long?'floor':'ceil'));
    if(!(span>0)||!(stopLoss>0)||(long?a>=b||stopLoss>=entry: a<=b||stopLoss<=entry)||targets.some((p,i)=>!(p>0)||(long?p<=entry||i>0&&p<=targets[i-1]:p>=entry||i>0&&p>=targets[i-1])))throw Error('回抽進場與 Fib 目標價位無效');
    return {entry,stopLoss,target:targets[0],targets};
  }
  function prices(f,direction,tick){const long=direction==='LONG',entry=E.quantize(f.confirm.close,tick,long?'ceil':'floor'),stopLoss=E.quantize(f.extreme+(long?-tick:tick),tick,long?'floor':'ceil'),span=Math.abs(f.impulse.price-f.extreme),targets=LEVELS.map(l=>E.quantize(f.impulse.price+(long?1:-1)*(-l)*span,tick,long?'floor':'ceil'));if(!(stopLoss>0)||(long?stopLoss>=entry:stopLoss<=entry)||targets.some((t,i)=>!(t>0)||(long?t<=entry||i>0&&t<=targets[i-1]:t>=entry||i>0&&t>=targets[i-1])))throw Error('結構目標或停損無效');return{entry,stopLoss,target:targets[0],targets};}
  function valid(c){if(c?.strategyVersion!==VERSION){const legacy=root.LegacyBodyMacdStrategy||(typeof require==='function'?require('./macd-body-legacy.js'):null);return legacy?.isVersion(c?.strategyVersion)?legacy.valid(c):false;}try{const f=c.fib,long=c.direction==='LONG',plan=prices(f,c.direction,c.tickSize),targets=c.plannedTargets||c.targets;if(c.profileId!=='4h15m'||c.entryType!=='MARKET_NEXT'||c.targetMode!=='FIB'||f.kind!=='PULLBACK_BREAK'||![f.highMacd,f.lowMacd].every(t=>t&&t.direction===c.direction&&(long?t.dif>0&&t.signal>0:t.dif<0&&t.signal<0)))return false;for(const point of [f.impulse,f.trigger,f.lowPoint])if(point.confirmedAt!==point.openTime+2700000||point.confirmedAt>f.confirm.openTime)return false;if(!(f.impulse.openTime<f.trigger.openTime&&f.trigger.openTime<f.lowPoint.openTime)||f.confirm.closeTime+1!==c.confirmedAt||f.lowMacd.at!==c.confirmedAt||f.highMacd.at>c.confirmedAt||c.expiresAt!==c.confirmedAt+900000)return false;if(long?!(f.trigger.price<f.impulse.price&&f.previousClose<=f.trigger.price&&f.confirm.close>f.trigger.price):!(f.trigger.price>f.impulse.price&&f.previousClose>=f.trigger.price&&f.confirm.close<f.trigger.price))return false;return (c.referenceEntry??c.entry)===plan.entry&&c.stopLoss===plan.stopLoss&&c.target===plan.target&&targets.length===4&&targets.every((x,i)=>x===plan.targets[i]);}catch{return false;}}
  function createAnalyzer(id='4h15m'){
    if(!PROFILES[id])throw Error('未知週期');const high=[],low=[],points=[];let bias=null,pending=null;
    function pushHigh(b){check(b,high.at(-1),14400000);high.push(clone(b));if(high.length>499)high.shift();bias=trend(high);}
    function pushLow(b,market){check(b,low.at(-1),900000);const prev=low.at(-1),at=b.closeTime+1;low.push(clone(b));if(low.length>499)low.shift();const lm=trend(low),direction=bias?.direction&&lm?.direction===bias.direction?bias.direction:null;let candidate=null;
      if(pending&&(at>=pending.expiresAt||pending.direction!==direction))pending=null;
      if(direction&&!pending&&prev){const long=direction==='LONG',side=long?'HIGH':'LOW',swings=points.filter(p=>p.side===side&&p.confirmedAt<=b.openTime),trigger=swings.at(-1),impulse=swings.at(-2),lowPoint=points.filter(p=>p.side!==(side)&&p.confirmedAt<=b.openTime&&p.openTime>trigger?.openTime).at(-1);
        if(trigger&&impulse&&lowPoint&&!trigger.broken&&(long?trigger.price<impulse.price&&prev.close<=trigger.price&&b.close>trigger.price:trigger.price>impulse.price&&prev.close>=trigger.price&&b.close<trigger.price)){
          const segment=low.filter(x=>x.openTime>impulse.openTime&&x.openTime<=b.openTime),extreme=long?Math.min(...segment.map(x=>x.low)):Math.max(...segment.map(x=>x.high)),fib={kind:'PULLBACK_BREAK',levels:[...LEVELS],impulse:clone(impulse),trigger:clone(trigger),lowPoint:clone(lowPoint),confirm:clone(b),previousClose:prev.close,extreme,highMacd:clone(bias),lowMacd:clone(lm)};
          try{const plan=prices(fib,direction,market.tickSize);candidate={symbol:market.symbol,direction,strategyVersion:VERSION,strategyName:'MACD回調結構',profileId:id,timeframeLabel:'4H＋15M',setupId:id+':'+direction+':'+trigger.openTime+':'+b.openTime,entryType:'MARKET_NEXT',targetMode:'FIB',exitFractions:[.2,.3,.3,.2],partialExit:true,targetCount:4,riskFraction:.05,...plan,tickSize:market.tickSize,stepSize:market.stepSize,confirmedAt:at,expiresAt:at+900000,fib,market:{...market},entryFilter:{enabled:false}};if(!valid(candidate))throw Error('驗證失敗');pending=clone(candidate);}catch{candidate=null;}
        }
      }
      for(const p of points)if(p.side==='HIGH'?b.close>p.price:b.close<p.price)p.broken=true;points.push(...pivots(low));if(points.length>200)points.splice(0,points.length-200);
      return{candidate,pending:pending?clone(pending):null,status:pending?'WAIT_FILL':direction?'WAIT_PULLBACK_STRUCTURE':'NO_ALIGNMENT',reason:pending?'回調小結構收盤突破，等待下一筆報價':direction?'MACD同向，等待回調低點與小結構突破':'等待4H與15M MACD同向',trend:bias,macdLow:lm,direction,entryFilter:{enabled:false}};
    }return{pushHigh,pushLow};
  }
  function analyze(market,higher,lower,asOf,capital=200,id='4h15m'){
    for(const [bars,d] of [[higher,E.INTERVALS[PROFILES[id].high]],[lower,E.INTERVALS[PROFILES[id].low]]])if(!bars.length||bars.at(-1).closeTime!==Math.floor(asOf/d)*d-1)throw Error('需要最新已收盤K線');
    const a=createAnalyzer(id);let h=0,r={pending:null};
    for(const b of lower){while(h<higher.length&&higher[h].closeTime<=b.closeTime)a.pushHigh(higher[h++]);if(h)r=a.pushLow(b,market);}return r;
  }
  const api={MODE:"STRUCTURE_ENTRY",VERSION,LEVELS,PROFILES,trend,prices,valid,createAnalyzer,analyze,isVersion:v=>[VERSION,'macd-body-bos-4h15m-v2','macd-lines-bos-4h15m-v1'].includes(v)};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;root.MacdStrategy=api;
})(typeof window!=='undefined'?window:globalThis);
