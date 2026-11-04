(function(root){
  "use strict";
  const E=root.StrategyEngine||(typeof require==="function"?require("./strategy-engine.js"):null);
  const VERSION="smc-ob-retest-v1";
  const PROFILES=Object.freeze({"4h15m":{id:"4h15m",label:"4H＋15M",high:"4h",low:"15m"},"1h5m":{id:"1h5m",label:"1H＋5M",high:"1h",low:"5m"}});
  const RULES=Object.freeze({pivotLeft:2,pivotRight:2,atrPeriod:14,displacement:1.2,obLookback:6,zoneMaxBars:80});
  function profile(id="4h15m"){if(!PROFILES[id])throw new Error("未知 SMC 時間框架");return PROFILES[id];}
  const copy=value=>JSON.parse(JSON.stringify(value));
  function atr(bars){if(bars.length<15)return null;let sum=0;for(let i=bars.length-14;i<bars.length;i++)sum+=Math.max(bars[i].high-bars[i].low,Math.abs(bars[i].high-bars[i-1].close),Math.abs(bars[i].low-bars[i-1].close));return sum/14;}
  function pivot(bars,swings){
    if(bars.length<5)return;const i=bars.length-3,b=bars[i],left=bars.slice(i-2,i),right=bars.slice(i+1,i+3);
    if([...left,...right].every(x=>x.high<b.high))swings.highs.push({price:b.high,at:b.openTime,confirmedAt:bars.at(-1).closeTime+1});
    if([...left,...right].every(x=>x.low>b.low))swings.lows.push({price:b.low,at:b.openTime,confirmedAt:bars.at(-1).closeTime+1});
    const minimum=bars[0].openTime;swings.highs=swings.highs.filter(s=>s.at>=minimum).slice(-100);swings.lows=swings.lows.filter(s=>s.at>=minimum).slice(-100);
  }
  function structure(swings){
    const highs=swings.highs,lows=swings.lows,h=highs.at(-1),l=lows.at(-1);
    if(!h||!l)return null;
    const priorLows=lows.filter(x=>x.at<h.at),priorHighs=highs.filter(x=>x.at<l.at);
    if(highs.length>=2&&priorLows.length>=2&&h.price>highs.at(-2).price&&priorLows.at(-1).price>priorLows.at(-2).price)return {direction:"UP",level:priorLows.at(-1).price,extremeAt:h.at};
    if(lows.length>=2&&priorHighs.length>=2&&l.price<lows.at(-2).price&&priorHighs.at(-1).price<priorHighs.at(-2).price)return {direction:"DOWN",level:priorHighs.at(-1).price,extremeAt:l.at};
    return null;
  }
  function check(bar,previous,interval){
    const duration=E.INTERVALS[interval];
    if(!bar||![bar.openTime,bar.closeTime,bar.open,bar.high,bar.low,bar.close].every(Number.isFinite)||bar.openTime%duration||bar.closeTime!==bar.openTime+duration-1||bar.low<=0||bar.high<Math.max(bar.open,bar.close)||bar.low>Math.min(bar.open,bar.close)||bar.high<bar.low||(previous&&bar.openTime!==previous.openTime+duration))throw new Error("SMC "+interval+" K 線缺漏或混用時間框架");
  }
  function createAnalyzer(id="4h15m"){
    const p=profile(id),high=[],low=[],hs={highs:[],lows:[]},ls={highs:[],lows:[]};
    const brokenStructures=new Set(),knownStructures=new Set();
    let zones=[],highCount=0,arm=null,pending=null,status={status:"WAIT_ZONE",reason:"等待高週期有效 OB"};
    function pushHigh(bar){
      check(bar,high.at(-1),p.high);const strength=atr(high),before=high.at(-1),oldLow=hs.lows.at(-1),oldHigh=hs.highs.at(-1);
      high.push(bar);highCount++;if(high.length>499)high.shift();
      for(const z of zones)if(!z.invalidAt&&((z.direction==="SHORT"?bar.close>z.high:bar.close<z.low)||highCount-z.sequence>RULES.zoneMaxBars))z.invalidAt=bar.closeTime+1;
      const bear=strength&&before&&oldLow&&before.close>=oldLow.price&&bar.close<oldLow.price&&bar.open-bar.close>=strength*RULES.displacement;
      const bull=strength&&before&&oldHigh&&before.close<=oldHigh.price&&bar.close>oldHigh.price&&bar.close-bar.open>=strength*RULES.displacement;
      if(bear||bull){
        const direction=bear?"SHORT":"LONG",origin=high.slice(Math.max(0,high.length-1-RULES.obLookback),-1).reverse().find(b=>bear?b.close>b.open:b.close<b.open);
        if(origin&&!zones.some(z=>z.originAt===origin.openTime&&z.direction===direction))zones.push({id:p.id+":"+direction+":"+origin.openTime,direction,low:origin.low,high:origin.high,originAt:origin.openTime,createdAt:bar.closeTime+1,sequence:highCount,fvg:null,used:false});
      }
      if(high.length>=3){const first=high.at(-3),last=high.at(-1),bearGap=last.high<first.low,bullGap=last.low>first.high;
        if(bearGap||bullGap)for(const z of zones)if(!z.invalidAt&&!z.fvg&&z.direction===(bearGap?"SHORT":"LONG")&&first.openTime>=z.originAt)
          z.fvg={low:bearGap?last.high:first.high,high:bearGap?first.low:last.low,createdAt:bar.closeTime+1};
      }
      zones=zones.filter(z=>highCount-z.sequence<=RULES.zoneMaxBars+2);pivot(high,hs);
    }
    function pushLow(bar,market,capital=E.SETTINGS.capital){
      check(bar,low.at(-1),p.low);const decision=bar.closeTime+1,strength=atr(low),prior=structure(ls),before=low.at(-1),structureKey=prior?prior.direction+":"+prior.extremeAt+":"+prior.level:null;
      if(prior&&!knownStructures.has(structureKey)){
        knownStructures.add(structureKey);
        if(low.some(b=>b.openTime>=prior.extremeAt&&(prior.direction==="UP"?b.close<prior.level:b.close>prior.level)))brokenStructures.add(structureKey);
      }
      if(!high.length||high.at(-1).closeTime+1>decision)throw new Error("SMC 高週期資料尚未收盤");
      low.push(bar);if(low.length>499)low.shift();let candidate=null;
      if(pending){
        const z=zones.find(z=>z.id===pending.highZone.id),long=pending.direction==="LONG";
        if(decision>=pending.expiresAt||!z||z.invalidAt){pending=null;status={status:"EXPIRED",reason:"等待逾時或高週期區域失效"};}
        else if(bar.openTime>=pending.confirmedAt&&(long?bar.low<=pending.entry:bar.high>=pending.entry)) {pending=null;status={status:"RETESTED",reason:"OB 已在歷史 K 線中回測，不回填成交"};}
        else if(long?bar.low<=pending.stopLoss||bar.high>=pending.target:bar.high>=pending.stopLoss||bar.low<=pending.target){pending=null;status={status:"INVALIDATED",reason:"進場前已觸及停損或 TP1"};}
      }
      if(arm){const z=zones.find(z=>z.id===arm.zoneId);if(!z||z.invalidAt||decision>arm.expiresAt){arm=null;status={status:"EXPIRED",reason:"區域失效或等待結構轉換逾時"};}}
      if(!arm&&!pending){
        const intact=prior&&!brokenStructures.has(structureKey)&&before&&(prior.direction==="UP"?before.close>=prior.level:before.close<=prior.level);
        const z=[...zones].reverse().find(z=>!z.invalidAt&&!z.used&&bar.openTime>=z.createdAt&&bar.high>=z.low&&bar.low<=z.high&&intact&&prior.direction===(z.direction==="SHORT"?"UP":"DOWN"));
        if(z){arm={zoneId:z.id,direction:z.direction,level:prior.level,touchAt:decision,expiresAt:decision+E.INTERVALS[p.high],extreme:z.direction==="SHORT"?bar.high:bar.low};status={status:"WAIT_SHIFT",reason:p.label+" 已進區，等待收盤突破保護結構",direction:z.direction,highZone:copy(z)};}
      }
      if(arm&&!pending){
        const long=arm.direction==="LONG";arm.extreme=long?Math.min(arm.extreme,bar.low):Math.max(arm.extreme,bar.high);
        const breaks=before&&(long?before.close<=arm.level&&bar.close>arm.level:before.close>=arm.level&&bar.close<arm.level),body=long?bar.close-bar.open:bar.open-bar.close;
        if(breaks&&strength&&body>=strength*RULES.displacement){
          const z=zones.find(z=>z.id===arm.zoneId),origin=low.slice(Math.max(0,low.length-1-RULES.obLookback),-1).reverse().find(b=>long?b.close<b.open:b.close>b.open);
          if(origin){
            const tick=Number(market.tickSize),entry=E.quantize((origin.high+origin.low)/2,tick,long?"floor":"ceil"),extreme=long?Math.min(origin.low,arm.extreme):Math.max(origin.high,arm.extreme);
            const stopLoss=Number((E.quantize(extreme,tick,long?"floor":"ceil")+(long?-tick:tick)).toFixed(Math.min(14,E.decimals(tick)))),targets=E.targets(entry,stopLoss,arm.direction,tick);
            if(entry>0&&stopLoss>0&&targets.every(t=>t>0)&&(long?bar.close>entry&&stopLoss<entry:bar.close<entry&&stopLoss>entry)){
              candidate={symbol:market.symbol,direction:arm.direction,strategyVersion:VERSION,profileId:p.id,timeframeLabel:p.label,entryType:"LIMIT_OB",partialExit:true,targetCount:4,riskFraction:.05,
                setupId:z.id+":"+decision,entry,stopLoss,target:targets[0],targets,tickSize:tick,stepSize:market.stepSize,confirmedAt:decision,expiresAt:decision+E.INTERVALS[p.high],trendAt:z.createdAt,
                highZone:copy(z),entryZone:{low:origin.low,high:origin.high,originAt:origin.openTime},shiftLevel:arm.level,touchAt:arm.touchAt,market:{...market}};
              candidate.plan=E.position(candidate,market,capital);pending=candidate;z.used=true;arm=null;status={status:"WAIT_RETEST",reason:"結構轉換確認，等待 OB 50% 回測",direction:candidate.direction,highZone:candidate.highZone};
            }
          }
        }
      }
      if(!arm&&!pending&&!candidate&&!["RETESTED","EXPIRED","INVALIDATED"].includes(status.status))status={status:"WAIT_ZONE",reason:"等待高週期 OB 與反向低週期結構"};
      if(prior&&(prior.direction==="UP"?bar.close<prior.level:bar.close>prior.level))brokenStructures.add(structureKey);
      if(arm&&(arm.direction==="SHORT"?bar.close<arm.level:bar.close>arm.level)){arm=null;status={status:"WAIT_ZONE",reason:"結構已破壞但未完成有效位移計畫，等待新結構"};}
      pivot(low,ls);
      return {candidate,pending:pending?copy(pending):null,...status,profileId:p.id,timeframeLabel:p.label,zones:zones.filter(z=>!z.invalidAt).map(copy)};
    }
    return {pushHigh,pushLow};
  }
  function analyze(market,higher,lower,asOf,capital=E.SETTINGS.capital,id="4h15m"){
    const p=profile(id);
    for(const [bars,interval]of[[higher,p.high],[lower,p.low]])if(!Array.isArray(bars)||!bars.length||bars.at(-1).closeTime!==Math.floor(asOf/E.INTERVALS[interval])*E.INTERVALS[interval]-1)throw new Error("SMC 需要最新已收盤 "+p.label+" 資料");
    const analyzer=createAnalyzer(id);let h=0,result={pending:null,status:"WAIT_ZONE",reason:"等待區域",profileId:p.id,timeframeLabel:p.label};
    for(const bar of lower){while(h<higher.length&&higher[h].closeTime<=bar.closeTime)analyzer.pushHigh(higher[h++]);if(h)result=analyzer.pushLow(bar,market,capital);}
    return result;
  }
  const api={VERSION,PROFILES,RULES,profile,atr,structure,createAnalyzer,analyze};
  if(typeof module!=="undefined"&&module.exports)module.exports=api;root.SmcEngine=api;
})(typeof self!=="undefined"?self:globalThis);
