(function(root){
  "use strict";
  const E=root.StrategyEngine||(typeof require==="function"?require("./strategy-engine.js"):null);
  const EMA=root.EmaEngine||(typeof require==="function"?require("./ema-engine.js"):null);
  const VERSION="ema-zone-bos-fib0715-v1",ENTRY_LEVEL=.715,LEVELS=Object.freeze([0,-.27,-.618,-1]),PROFILES=EMA.PROFILES;
  const copy=value=>JSON.parse(JSON.stringify(value));
  function prices(anchors,direction,tick){
    if(!["LONG","SHORT"].includes(direction)||!Number.isFinite(tick)||tick<=0)throw Error("Fib方向或價格精度無效");
    const a=anchors?.a?.price,b=anchors?.b?.price,long=direction==="LONG";
    if(![a,b].every(n=>Number.isFinite(n)&&n>0)||(long?a>=b:a<=b))throw Error("Fib高低點順序無效");
    const value=level=>b+level*(a-b),entry=E.quantize(value(ENTRY_LEVEL),tick,long?"floor":"ceil");
    const stopLoss=Number((E.quantize(a,tick,long?"floor":"ceil")+(long?-tick:tick)).toFixed(Math.min(14,E.decimals(tick))));
    const targets=LEVELS.map(level=>E.quantize(value(level),tick,long?"ceil":"floor")),distance=Math.abs(entry-stopLoss);
    if(![entry,stopLoss,...targets].every(n=>Number.isFinite(n)&&n>0)||!(distance>0)||(long?stopLoss>=entry:stopLoss<=entry)||targets.some((t,i)=>long?t<=entry||(i&&t<=targets[i-1]):t>=entry||(i&&t>=targets[i-1]))||Math.abs(targets[0]-entry)/distance<2)throw Error("Fib價位無效或TP1不足2R");
    return {entry,stopLoss,target:targets[0],targets,rewardRisks:targets.map(t=>Math.abs(t-entry)/distance)};
  }
  function valid(candidate){
    const bos=root.BosEngine||(typeof require==="function"?require("./bos-engine.js"):null);if(bos?.isVersion(candidate?.strategyVersion))return bos.valid(candidate);
    try{
      const p=PROFILES[candidate.profileId],f=candidate.fib,d=E.INTERVALS[p?.low],h=E.INTERVALS[p?.high],long=candidate.direction==="LONG";
      if(candidate.strategyVersion!==VERSION||candidate.targetMode!=="FIB"||candidate.entryType!=="LIMIT_FIB"||!p||!f||f.version!==2||f.entryLevel!==ENTRY_LEVEL||!Array.isArray(f.levels)||f.levels.length!==4||f.levels.some((v,i)=>v!==LEVELS[i])||!Array.isArray(candidate.exitFractions)||candidate.exitFractions.length!==4||candidate.exitFractions.some((v,i)=>v!==[.2,.3,.3,.2][i]))return false;
      for(const point of [f.a,f.b,f.structure?.pivot])if(!point||!Number.isFinite(point.openTime)||point.openTime%d||point.confirmedAt!==point.openTime+3*d)return false;
      const z=f.highZone,touch=f.zoneTouch,breakBar=f.structure.breakBar;
      if(!z||z.direction!==candidate.direction||z.createdAt!==z.originAt+3*h||z.originAt%h||z.id!==p.id+":"+candidate.direction+":"+z.originAt||z.invalidAt)return false;
      check(z.source,null,p.high);check(touch,null,p.low);check(breakBar,null,p.low);check(f.a.bar,null,p.low);check(f.b.bar,null,p.low);check(f.structure.pivot.bar,null,p.low);
      if(f.b.bar.openTime!==f.b.openTime||f.b.price!==(long?f.b.bar.high:f.b.bar.low)||f.structure.pivot.bar.openTime!==f.structure.pivot.openTime||f.structure.pivot.price!==(long?f.structure.pivot.bar.high:f.structure.pivot.bar.low))return false;
      const zoneLow=long?z.source.low:Math.max(z.source.open,z.source.close),zoneHigh=long?Math.min(z.source.open,z.source.close):z.source.high;
      if(z.originAt!==z.source.openTime||z.low!==zoneLow||z.high!==zoneHigh||touch.openTime<z.createdAt||touch.high<z.low||touch.low>z.high||f.a.openTime!==f.a.bar.openTime||f.a.openTime<touch.openTime||f.a.openTime<=f.structure.pivot.openTime||f.a.confirmedAt>breakBar.closeTime+1||f.a.price!==(long?f.a.bar.low:f.a.bar.high)||(long?f.a.bar.close>=f.a.bar.open:f.a.bar.close<=f.a.bar.open))return false;
      if(breakBar.openTime<touch.openTime||f.structure.pivot.confirmedAt>breakBar.openTime||!Number.isFinite(f.structure.previousClose)||(long?f.structure.previousClose>f.structure.pivot.price||breakBar.close<=f.structure.pivot.price:f.structure.previousClose<f.structure.pivot.price||breakBar.close>=f.structure.pivot.price))return false;
      if(f.b.openTime<breakBar.closeTime+1||candidate.confirmedAt!==f.b.confirmedAt||candidate.confirmedAt>=breakBar.closeTime+1+h||candidate.expiresAt!==candidate.confirmedAt+h||candidate.setupId!==p.id+":"+candidate.direction+":"+f.a.openTime+":"+f.b.openTime+":"+breakBar.openTime)return false;
      if(long?f.b.price<=f.structure.pivot.price:f.b.price>=f.structure.pivot.price)return false;
      const plan=prices(f,candidate.direction,candidate.tickSize),targets=candidate.plannedTargets||candidate.targets,entry=candidate.referenceEntry??candidate.entry,t=candidate.emaTrend;
      if(!t||![t.ema20,t.ema60,t.ema200,t.at].every(Number.isFinite)||t.at%h||t.at>candidate.confirmedAt||t.direction!==candidate.direction||(long?!(t.ema20>t.ema60&&t.ema60>t.ema200):!(t.ema20<t.ema60&&t.ema60<t.ema200)))return false;
      return entry===plan.entry&&candidate.stopLoss===plan.stopLoss&&candidate.target===plan.target&&Array.isArray(targets)&&targets.length===4&&targets.every((v,i)=>v===plan.targets[i]);
    }catch{return false;}
  }
  function check(bar,previous,interval){
    const d=E.INTERVALS[interval];if(!bar||![bar.openTime,bar.closeTime,bar.open,bar.high,bar.low,bar.close,bar.volume].every(Number.isFinite)||bar.low<=0||bar.volume<0||bar.high<Math.max(bar.open,bar.close)||bar.low>Math.min(bar.open,bar.close)||bar.openTime%d||bar.closeTime!==bar.openTime+d-1||(previous&&bar.openTime!==previous.openTime+d))throw Error("Fib K線缺漏或時間框架錯誤");
  }
  function createAnalyzer(id="4h15m",options={}){
    const p=PROFILES[id];if(!p)throw Error("未知Fib時間框架");
    const higher=[],lower=[],highs=[],lows=[],zones=[],brokenHighs=new Set(),brokenLows=new Set();
    let bias=null,arm=null,wave=null,pending=null;
    function alive(zone){return zone&&!zone.invalidAt&&zone.originAt>=higher[0].openTime;}
    function pushHigh(bar){
      check(bar,higher.at(-1),p.high);higher.push(bar);if(higher.length>499)higher.shift();
      for(const z of zones)if(!z.invalidAt&&(z.direction==="SHORT"?bar.close>z.high:bar.close<z.low))z.invalidAt=bar.closeTime+1;
      if(higher.length>=5){const i=higher.length-3,b=higher[i],near=[...higher.slice(i-2,i),...higher.slice(i+1,i+3)];
        for(const direction of ["SHORT","LONG"]){const long=direction==="LONG",pivot=near.every(n=>long?n.low>b.low:n.high<b.high);if(pivot){zones.push({id:p.id+":"+direction+":"+b.openTime,direction,low:long?b.low:Math.max(b.open,b.close),high:long?Math.min(b.open,b.close):b.high,originAt:b.openTime,createdAt:bar.closeTime+1,source:copy(b)});}}
      }
      if(zones.length>100)zones.shift();bias=EMA.trend(higher);
      if(pending&&pending.direction!==bias?.direction){pending=null;wave=null;arm=null;}if(wave&&wave.direction!==bias?.direction)wave=null;if(arm&&arm.direction!==bias?.direction)arm=null;
    }
    function pushLow(bar,market,capital=200){
      check(bar,lower.at(-1),p.low);const before=lower.at(-1),decision=bar.closeTime+1;
      if(!higher.length||higher.at(-1).closeTime>bar.closeTime)throw Error("Fib高週期資料尚未收盤");
      lower.push(bar);if(lower.length>499)lower.shift();let candidate=null,status="WAIT_ZONE",reason="等待價格進入已確認的高週期區域";
      if(pending){const long=pending.direction==="LONG",z=zones.find(z=>z.id===pending.fib.highZone.id);
        if(decision>=pending.expiresAt||!alive(z)){pending=null;wave=null;arm=null;status="EXPIRED";reason="Fib計畫到期或高框架區域失效";}
        else if(bar.openTime>=pending.confirmedAt){
          if(long?bar.low<=pending.entry:bar.high>=pending.entry){pending=null;wave=null;arm=null;status="MISSED";reason="0.715已在歷史K線觸及，不回填成交";}
          else if(long?bar.high>=pending.fib.b.price:bar.low<=pending.fib.b.price){pending=null;status="INVALIDATED";reason="未進場前出現新極值，等待新的L1確認";}
        }
      }
      if(wave&&(!alive(zones.find(z=>z.id===wave.zone.id))||(!pending&&decision>=wave.expiresAt))){wave=null;if(pending)pending=null;status="EXPIRED";reason="等待L1逾時或高框架區域失效";}
      if(arm&&(!alive(zones.find(z=>z.id===arm.zone.id))||decision>=arm.expiresAt)){arm=null;status="EXPIRED";reason="等待結構突破逾時或區域失效";}
      let newHigh=null,newLow=null;
      if(lower.length>=5){const i=lower.length-3,b=lower[i],near=[...lower.slice(i-2,i),...lower.slice(i+1,i+3)],point=price=>({price,openTime:b.openTime,confirmedAt:decision,bar:copy(b)});
        if(near.every(n=>n.high<b.high)){newHigh=point(b.high);highs.push(newHigh);}if(near.every(n=>n.low>b.low)){newLow=point(b.low);lows.push(newLow);}
      }
      while(highs.length>100)highs.shift();while(lows.length>100)lows.shift();
      if(!arm&&!wave&&!pending&&bias?.direction){
        const long=bias.direction==="LONG",z=zones.filter(z=>z.direction===bias.direction&&alive(z)).at(-1),points=long?highs:lows,broken=long?brokenHighs:brokenLows;
        const level=[...points].reverse().find(v=>v.openTime>=lower[0].openTime&&v.confirmedAt<=bar.openTime&&!broken.has(v.openTime));
        if(z&&bar.openTime>=z.createdAt&&bar.high>=z.low&&bar.low<=z.high&&level){arm={zone:z,direction:bias.direction,touchBar:copy(bar),level:copy(level),expiresAt:decision+E.INTERVALS[p.high]};}
      }
      if(arm&&!wave&&!pending&&before){
        const long=arm.direction==="LONG",level=arm.level,broken=long?brokenHighs:brokenLows,crosses=!broken.has(level.openTime)&&(long?before.close<=level.price&&bar.close>level.price:before.close>=level.price&&bar.close<level.price);
        if(crosses){
          const origin=[...(long?lows:highs)].reverse().find(v=>v.openTime>=arm.touchBar.openTime&&v.openTime>level.openTime&&v.confirmedAt<=decision&&(long?v.bar.close<v.bar.open:v.bar.close>v.bar.open));
          if(origin){wave={zone:arm.zone,direction:arm.direction,a:copy(origin),touchBar:arm.touchBar,structure:{pivot:level,breakBar:copy(bar),previousClose:before.close},expiresAt:decision+E.INTERVALS[p.high]};arm=null;status="WAIT_EXTREME";reason="已收盤突破L0，等待突破後的新L1確認";}
          else{arm=null;status="INVALIDATED";reason="結構已突破但反向K高低點尚未確認，略過此波段";}
        }else if(long?bar.close>level.price:bar.close<level.price){arm=null;status="INVALIDATED";reason="L0已被破壞，等待新結構";}
      }
      if(wave&&!pending){
        const long=wave.direction==="LONG",b=long?newHigh:newLow,breakAt=wave.structure.breakBar.closeTime+1;
        if(b&&b.openTime>=breakAt&&(long?b.price>wave.structure.pivot.price:b.price<wave.structure.pivot.price)){
          const fib={version:2,a:copy(wave.a),b:copy(b),entryLevel:ENTRY_LEVEL,levels:[...LEVELS],highZone:copy(wave.zone),zoneTouch:copy(wave.touchBar),structure:copy(wave.structure)};
          try{const plan=prices(fib,wave.direction,Number(market.tickSize)),right=lower.filter(x=>x.openTime>b.openTime);
            if(right.some(x=>long?x.low<=plan.entry:x.high>=plan.entry)){wave=null;status="MISSED";reason="L1確認前已觸及0.715，不回填進場";}
            else{candidate={symbol:market.symbol,direction:wave.direction,strategyVersion:VERSION,strategyName:"EMA＋Fib",profileId:p.id,timeframeLabel:p.label,
              setupId:p.id+":"+wave.direction+":"+fib.a.openTime+":"+fib.b.openTime+":"+fib.structure.breakBar.openTime,entryType:"LIMIT_FIB",targetMode:"FIB",exitFractions:[.2,.3,.3,.2],partialExit:true,targetCount:4,riskFraction:.05,...plan,
              tickSize:Number(market.tickSize),stepSize:market.stepSize,confirmedAt:decision,expiresAt:decision+E.INTERVALS[p.high],trendAt:bias.at,emaTrend:copy(bias),fib,market:{...market}};pending=candidate;status="WAIT_FILL";reason="區域＋收盤破結構＋L1已確認，預掛Fib 0.715";}
          }catch(error){wave=null;status="INVALID_LEVELS";reason=error.message;}
        }
      }
      for(const point of highs)if(point.confirmedAt<=decision&&bar.close>point.price)brokenHighs.add(point.openTime);for(const point of lows)if(point.confirmedAt<=decision&&bar.close<point.price)brokenLows.add(point.openTime);
      if(!bias){status="WARMUP";reason="等待200根已收盤高週期K線";}
      else if(!bias.direction){status="NO_TREND";reason="高週期EMA20／60／200未完整排列";pending=null;wave=null;arm=null;candidate=null;}
      if(arm){status="WAIT_BREAK";reason="已進高框架區域，等待小框架收盤突破L0";}if(wave&&!pending){status="WAIT_EXTREME";reason="已破L0，等待突破後的新L1確認";}
      let exposed=pending?copy(pending):null,filter={enabled:false};if(exposed){status="WAIT_FILL";reason="預掛Fib 0.715，等待新成交觸價";
        if(options.rsiFilter){filter=EMA.entryFilter(lower,exposed.direction);if(!filter.matches){exposed=null;candidate=null;status="FILTERED";reason="最新已收盤小框架RSI／放量條件未通過";}}
        if(exposed){exposed.entryFilter=filter;if(candidate)candidate=copy(exposed);}
      }
      return {candidate,pending:exposed,status,reason,trend:bias,direction:bias?.direction||null,entryFilter:filter,profileId:p.id,timeframeLabel:p.label};
    }
    return {pushHigh,pushLow};
  }
  function analyze(market,higher,lower,asOf,capital=200,id="4h15m",options={}){
    const p=PROFILES[id];if(!p)throw Error("未知Fib時間框架");
    for(const [bars,interval]of[[higher,p.high],[lower,p.low]])if(!Array.isArray(bars)||!bars.length||bars.at(-1).closeTime!==Math.floor(asOf/E.INTERVALS[interval])*E.INTERVALS[interval]-1)throw Error("Fib需要最新已收盤的兩套獨立時間框架資料");
    const analyzer=createAnalyzer(id,options);let h=0,result={candidate:null,pending:null,status:"WARMUP",trend:null,entryFilter:{enabled:false}};
    for(const bar of lower){while(h<higher.length&&higher[h].closeTime<=bar.closeTime)analyzer.pushHigh(higher[h++]);if(h)result=analyzer.pushLow(bar,market,capital);}
    return result;
  }
  const api={VERSION,ENTRY_LEVEL,LEVELS,PROFILES,prices,valid,createAnalyzer,analyze,isVersion:v=>v===VERSION||["sma83-ema200-bos-15m5m-v1","ema20-60-bos-dual-v1"].includes(v)};
  if(typeof module!=="undefined"&&module.exports)module.exports=api;root.FibEngine=api;
})(typeof window!=="undefined"?window:globalThis);
