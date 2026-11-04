(function(root){
  "use strict";
  const E=root.StrategyEngine||(typeof require==="function"?require("./strategy-engine.js"):null);
  const Fib=root.FibEngine||(typeof require==="function"?require("./fib-engine.js"):null);
  const STATES=new Set(["PENDING","HIT","STOPPED","REVIEW","UNAVAILABLE"]);
  function create(entry,stop,direction,tick,count=3){
    const long=direction==="LONG",distance=Math.abs(entry-stop);
    return [2,3,4,5].slice(0,count).map((rr,index)=>{
      let price=E.quantize(entry+(long?1:-1)*rr*distance,tick,long?"ceil":"floor");
      if(Math.abs(price-entry)/distance<rr)price=Number((price+(long?tick:-tick)).toFixed(Math.min(14,E.decimals(tick))));
      const valid=Number.isFinite(price)&&price>0&&distance>0&&(long?price>entry:price<entry);
      return {label:"TP"+(index+1),rr,price:valid?price:null,status:valid?"PENDING":"UNAVAILABLE"};
    });
  }
  function createFib(trade){
    if(!Fib?.valid(trade))throw Error("Fib目標計畫無效");
    const entry=trade.entry??trade.referenceEntry,prices=trade.plannedTargets||trade.targets,distance=Math.abs(entry-trade.stopLoss);
    return prices.map((price,i)=>({label:"TP"+(i+1),rr:Math.abs(price-entry)/distance,price,fibLevel:Fib.LEVELS[i],mode:"FIB",status:"PENDING"}));
  }
  const stopPrice=trade=>trade.targetMode==="FIB"&&trade.exitGuard?trade.exitGuard.price:trade.stopLoss;
  function hitStop(trade,price){
    const long=trade.direction==="LONG",guard=trade.targetMode==="FIB"?trade.exitGuard:null;
    if(guard)return long?price<guard.price||(price===guard.price&&guard.bestPrice>guard.price):price>guard.price||(price===guard.price&&guard.bestPrice<guard.price);
    return long?price<=trade.stopLoss:price>=trade.stopLoss;
  }
  const pending=trade=>Array.isArray(trade.targets)&&trade.targets.some(t=>t.status==="PENDING");
  function valid(trade){
    if(trade.targets===undefined)return true; // Legacy records are preserved, never backfilled.
    if(!Array.isArray(trade.targets)||![3,4].includes(trade.targets.length)||!(trade.entry>0)||!Number.isFinite(trade.targetsLastQuoteAt))return false;
    let expected;try{expected=trade.targetMode==="FIB"?createFib(trade):create(trade.entry,trade.stopLoss,trade.direction,trade.tickSize,trade.targets.length);}catch{return false;}
    return trade.targets.every((t,i)=>t&&t.label===expected[i].label&&t.rr===expected[i].rr&&t.price===expected[i].price&&(trade.targetMode!=="FIB"||(t.mode==="FIB"&&t.fibLevel===expected[i].fibLevel))&&
      STATES.has(t.status)&&(t.price===null?t.status==="UNAVAILABLE":t.status!=="UNAVAILABLE")&&
      (!["HIT","STOPPED","REVIEW"].includes(t.status)||Number.isFinite(t.at)));
  }
  function interrupt(trade,reason,at){
    if(!pending(trade))return false;
    for(const target of trade.targets)if(target.status==="PENDING")Object.assign(target,{status:"REVIEW",reason,at});return true;
  }
  function quote(trade,price,at){
    const long=trade.direction==="LONG",stopped=hitStop(trade,price);
    for(const target of trade.targets||[])if(target.status==="PENDING"&&(stopped||(long?price>=target.price:price<=target.price)))
      Object.assign(target,{status:stopped?"STOPPED":"HIT",at,observedPrice:price});
  }
  function bar(trade,candle,policy){
    const long=trade.direction==="LONG",gapStop=long?candle.open<=stopPrice(trade):candle.open>=stopPrice(trade);
    const stop=long?candle.low<=stopPrice(trade):candle.high>=stopPrice(trade);
    for(const target of trade.targets||[])if(target.status==="PENDING"){
      const gapHit=long?candle.open>=target.price:candle.open<=target.price,hit=long?candle.high>=target.price:candle.low<=target.price;
      if(!hit&&!stop)continue;
      const ambiguous=!gapStop&&!gapHit&&hit&&stop;
      Object.assign(target,{status:gapStop?"STOPPED":gapHit?"HIT":ambiguous&&policy==="review"?"REVIEW":stop?"STOPPED":"HIT",
        at:gapStop||gapHit?candle.openTime:candle.closeTime+1,barTime:candle.openTime,ambiguous});
    }
  }
  function stats(trades,options={}){
    const entered=trades.filter(t=>t.entry>0&&t.quantity>0),eligible=entered.filter(t=>Array.isArray(t.targets));
    return {eligible:eligible.length,legacy:entered.length-eligible.length,levels:[2,3,4,5].map((rr,i)=>{
      const rows=eligible.filter(t=>t.targets[i]).map(t=>({...t.targets[i],recovering:!!t.recovery?.pending})),hits=rows.filter(t=>t.status==="HIT").length,stopped=rows.filter(t=>t.status==="STOPPED").length;
      const modes=new Set(rows.map(t=>t.mode||"R")),mode=modes.size>1?"MIXED":modes.values().next().value||(options.targetMode==="FIB"||trades.some(t=>t.targetMode==="FIB")?"FIB":"R");
      return {label:"TP"+(i+1),rr:mode==="R"?rr:null,mode,fibLevel:mode==="FIB"?Fib.LEVELS[i]:null,eligible:rows.length,untracked:entered.length-rows.length,hits,stopped,resolved:hits+stopped,rate:hits+stopped?100*hits/(hits+stopped):null,
        recovering:rows.filter(t=>t.status==="PENDING"&&t.recovering).length,pending:rows.filter(t=>t.status==="PENDING"&&!t.recovering).length,review:rows.filter(t=>t.status==="REVIEW").length,
        unavailable:rows.filter(t=>t.status==="UNAVAILABLE").length};
    })};
  }
  const api={create,createFib,stopPrice,hitStop,pending,valid,interrupt,quote,bar,stats};
  if(typeof module!=="undefined"&&module.exports)module.exports=api;root.TargetEngine=api;
})(typeof self!=="undefined"?self:globalThis);
