(function(root){
  'use strict';
  const E=root.StrategyEngine||(typeof require==='function'?require('./strategy-engine.js'):null);
  const VERSION='ema20-60-bos-dual-v1', LEVELS=[0,-.27,-.618,-1];
  const PROFILES={'1h5m':{id:'1h5m',label:'1H＋5M',high:'1h',low:'5m'},'4h15m':{id:'4h15m',label:'4H＋15M',high:'4h',low:'15m'}};
  const clone=x=>JSON.parse(JSON.stringify(x));
  function trend(bars){if(bars.length<60)return null;const c=bars.slice(-499).map(b=>b.close);function ema(n){let v=c.slice(0,n).reduce((a,b)=>a+b,0)/n;for(let i=n;i<c.length;i++)v+=(c[i]-v)*2/(n+1);return v;}const ema20=ema(20),ema60=ema(60);return {ema20,ema60,direction:ema20>ema60?'LONG':ema20<ema60?'SHORT':null,at:bars.at(-1).closeTime+1};}
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
  function valid(c){
    try{
      if(c.strategyVersion==='sma83-ema200-bos-15m5m-v1')return (root.LegacyBosEngine||(typeof require==='function'?require('./bos-legacy.js'):null)).valid(c);
      const profile=PROFILES[c.profileId];if(!profile)return false;const lo=E.INTERVALS[profile.low],hi=E.INTERVALS[profile.high];
      const f=c.fib,long=c.direction==='LONG',t=f?.trend;
      if(c.strategyVersion!==VERSION||!['LONG','SHORT'].includes(c.direction)||c.entryType!=='LIMIT_FIB'||c.targetMode!=='FIB'||f?.kind!=='BOS_RETEST'||JSON.stringify(f.levels)!==JSON.stringify(LEVELS)||JSON.stringify(c.exitFractions)!=='[0.2,0.3,0.3,0.2]')return false;
      if(!t||t.direction!==c.direction||![t.ema20,t.ema60,t.at].every(Number.isFinite)||(long?!(t.ema20>t.ema60):!(t.ema20<t.ema60))||t.at%hi||t.at>c.confirmedAt)return false;
      for(const b of [f.breakBar,f.confirm,f.a.bar,f.b.bar,f.pivot.bar])check(b,null,lo);
      const pivot=f.pivot;
      if(pivot.bar.openTime!==pivot.openTime||f.a.bar.openTime!==f.a.openTime||f.b.bar.openTime!==f.b.openTime||f.a.confirmedAt!==f.a.openTime+(3*lo)||f.a.confirmedAt>f.breakBar.openTime||f.a.price!==(long?f.a.bar.low:f.a.bar.high)||f.b.price!==(long?f.b.bar.high:f.b.bar.low)||!Number.isFinite(f.pullbackExtreme)||(long?f.pullbackExtreme>f.confirm.low:f.pullbackExtreme<f.confirm.high)||f.confirm.openTime-f.breakBar.openTime>12*lo)return false;
      if(pivot.confirmedAt!==pivot.openTime+(3*lo)||pivot.confirmedAt>f.breakBar.openTime||pivot.price!==(long?pivot.bar.high:pivot.bar.low)||!(f.averageVolume>0)||f.breakBar.volume<=f.averageVolume||f.confirm.openTime<=f.breakBar.openTime||f.a.openTime>=f.breakBar.openTime||f.b.openTime<f.breakBar.openTime||f.b.openTime>=f.confirm.openTime)return false;
      if(long?!(f.previousClose<=pivot.price&&f.breakBar.close>pivot.price&&f.confirm.low<=pivot.price&&f.confirm.close>pivot.price):!(f.previousClose>=pivot.price&&f.breakBar.close<pivot.price&&f.confirm.high>=pivot.price&&f.confirm.close<pivot.price))return false;
      if(!f.zone||f.zone.invalid||f.zone.side!==(long?'LOW':'HIGH')||f.zone.originAt%hi||f.zone.createdAt!==f.zone.originAt+(3*hi)||f.zone.createdAt>f.breakBar.openTime||!Number.isFinite(f.zone.low)||!Number.isFinite(f.zone.high)||f.zone.low>f.zone.high)return false;
      if(c.confirmedAt!==f.confirm.closeTime+1||c.expiresAt!==c.confirmedAt+lo||c.setupId!==c.profileId+':'+c.direction+':'+f.breakBar.openTime+':'+f.confirm.openTime)return false;
      const p=prices(f,c.direction,c.tickSize),ts=c.plannedTargets||c.targets;
      return (c.referenceEntry??c.entry)===p.entry&&c.stopLoss===p.stopLoss&&c.target===p.target&&ts?.length===4&&ts.every((v,i)=>v===p.targets[i]);
    }catch{return false;}
  }
  function createAnalyzer(id='1h5m'){
    if(!PROFILES[id])throw Error('未知週期');const lo=E.INTERVALS[PROFILES[id].low],hi=E.INTERVALS[PROFILES[id].high];
    const high=[],low=[],points=[],zones=[];let bias=null,wave=null,pending=null;
    function pushHigh(b){
      check(b,high.at(-1),hi);high.push(clone(b));if(high.length>499)high.shift();
      for(const z of zones)if(z.side==='LOW'?b.close<z.low:b.close>z.high)z.invalid=true;
      for(const p of pivots(high))zones.push({side:p.side,low:p.side==='LOW'?p.bar.low:Math.max(p.bar.open,p.bar.close),high:p.side==='LOW'?Math.min(p.bar.open,p.bar.close):p.bar.high,createdAt:p.confirmedAt,originAt:p.openTime});
      if(zones.length>100)zones.shift();bias=trend(high);
      if(wave&&wave.direction!==bias?.direction)wave=null;
      if(pending&&pending.direction!==bias?.direction)pending=null;
    }
    function pushLow(b,market){
      check(b,low.at(-1),lo);if(!high.length||high.at(-1).closeTime>b.closeTime)throw Error('高框架尚未收盤');
      const prev=low.at(-1),at=b.closeTime+1;let candidate=null,status='WAIT_BOS',reason='等待5M放量收盤突破';
      if(pending&&at>=pending.expiresAt)pending=null;
      low.push(clone(b));if(low.length>499)low.shift();
      if(!bias?.direction){wave=null;pending=null;status=bias?'NO_TREND':'WARMUP';reason='等待大框架EMA20／60同向排列';}
      else{
        const long=bias.direction==='LONG';
        if(wave&&(b.openTime-wave.breakBar.openTime>12*lo||wave.zone.invalid||(long?b.close<wave.zone.low:b.close>wave.zone.high)))wave=null;
        if(wave&&b.openTime>wave.breakBar.openTime){
          const touch=long?b.low<=wave.pivot.price:b.high>=wave.pivot.price;
          if(touch){
            wave.pullbackExtreme=wave.pullbackExtreme==null?(long?b.low:b.high):(long?Math.min(wave.pullbackExtreme,b.low):Math.max(wave.pullbackExtreme,b.high));
            if(long?b.close>wave.pivot.price:b.close<wave.pivot.price){
              const f={kind:'BOS_RETEST',version:1,levels:[...LEVELS],a:clone(wave.a),b:clone(wave.b),pivot:clone(wave.pivot),breakBar:clone(wave.breakBar),previousClose:wave.previousClose,averageVolume:wave.averageVolume,zone:clone(wave.zone),trend:clone(bias),confirm:clone(b),pullbackExtreme:wave.pullbackExtreme};
              try{
                const p=prices(f,bias.direction,market.tickSize);
                candidate={symbol:market.symbol,direction:bias.direction,strategyVersion:VERSION,strategyName:'EMA20／60 · BOS',profileId:id,timeframeLabel:PROFILES[id].label,setupId:id+':'+bias.direction+':'+wave.breakBar.openTime+':'+b.openTime,entryType:'LIMIT_FIB',targetMode:'FIB',exitFractions:[.2,.3,.3,.2],partialExit:true,targetCount:4,riskFraction:.05,...p,tickSize:market.tickSize,stepSize:market.stepSize,confirmedAt:at,expiresAt:at+lo,emaTrend:clone(bias),fib:f,market:{...market},entryFilter:{enabled:false}};
                if(!valid(candidate))throw Error('計畫驗證失敗');pending=clone(candidate);
              }catch(e){status='INVALID_LEVELS';reason=e.message;}wave=null;
            }
          }
          // Do not use the confirmation candle's unknown intrabar high/low as the Fib target anchor.
          if(wave&&(long?b.high>wave.b.price:b.low<wave.b.price))wave.b={price:long?b.high:b.low,openTime:b.openTime,bar:clone(b)};
        }
        if(!wave&&!pending&&prev&&low.length>=21){
          const p=[...points].reverse().find(p=>p.side===(long?'HIGH':'LOW')&&!p.broken&&p.confirmedAt<=b.openTime);
          if(p&&(long?prev.close<=p.price&&b.close>p.price:prev.close>=p.price&&b.close<p.price)){
            const avg=low.slice(-21,-1).reduce((s,x)=>s+x.volume,0)/20;
            const zone=[...zones].reverse().find(z=>!z.invalid&&z.side===(long?'LOW':'HIGH')&&z.createdAt<=b.openTime&&(long?b.close>z.high:b.close<z.low));
            const a=[...points].reverse().find(x=>x.side===(long?'LOW':'HIGH')&&x.confirmedAt<=b.openTime);
            if(zone&&a&&avg>0&&b.volume>avg)wave={direction:bias.direction,pivot:clone(p),zone,a:clone(a),b:{price:long?b.high:b.low,openTime:b.openTime,bar:clone(b)},breakBar:clone(b),previousClose:prev.close,averageVolume:avg};
          }
        }
      }
      for(const p of points)if(p.side==='HIGH'?b.close>p.price:b.close<p.price)p.broken=true;
      points.push(...pivots(low));if(points.length>200)points.splice(0,points.length-200);
      if(wave){status='WAIT_RETEST';reason='已放量BOS，等待回抽突破位並收回';}
      if(pending){status='WAIT_FILL';reason='回抽確認完成，等待確認價限價成交';}
      return {candidate,pending:pending?clone(pending):null,status,reason,trend:bias,direction:bias?.direction||null,entryFilter:{enabled:false}};
    }
    return {pushHigh,pushLow};
  }
  function analyze(market,higher,lower,asOf,capital=200,id='15m5m'){
    for(const [bars,d] of [[higher,E.INTERVALS[PROFILES[id].high]],[lower,E.INTERVALS[PROFILES[id].low]]])if(!bars.length||bars.at(-1).closeTime!==Math.floor(asOf/d)*d-1)throw Error('需要最新已收盤K線');
    const a=createAnalyzer(id);let h=0,r={pending:null};
    for(const b of lower){while(h<higher.length&&higher[h].closeTime<=b.closeTime)a.pushHigh(higher[h++]);if(h)r=a.pushLow(b,market);}return r;
  }
  const api={VERSION,LEVELS,PROFILES,trend,prices,valid,createAnalyzer,analyze,isVersion:v=>v===VERSION};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;root.BosEngine=api;
})(typeof window!=='undefined'?window:globalThis);
