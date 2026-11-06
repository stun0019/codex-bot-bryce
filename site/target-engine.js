(function(root){
  "use strict";
  const E=root.StrategyEngine||(typeof require==="function"?require("./strategy-engine.js"):null);
  const Single=root.SmcEntry||(typeof require==='function'?require('./smc-entry.js'):null);
  function createSingle(t){const entry=t.entry??t.referenceEntry,p=Single.target(entry,t.stopLoss,t.direction,t.tickSize);return[{label:'TP1',rr:Math.abs(p-entry)/Math.abs(entry-t.stopLoss),price:p,mode:'SINGLE',status:'PENDING'}];}
  const STATES=new Set(["PENDING","HIT","STOPPED","REVIEW","UNAVAILABLE"]);
  const stopPrice=trade=>trade.stopLoss;
  function hitStop(trade,price){
    const long=trade.direction==="LONG";
    return long?price<=trade.stopLoss:price>=trade.stopLoss;
  }
  const pending=trade=>Array.isArray(trade.targets)&&trade.targets.some(t=>t.status==="PENDING");
  function valid(trade){
    if(trade.targets===undefined)return !trade.entry;
    if(!Array.isArray(trade.targets)||!Single.isSingle(trade)||trade.targets.length!==1||!(trade.entry>0)||!Number.isFinite(trade.targetsLastQuoteAt))return false;
    let expected;try{expected=createSingle(trade);}catch{return false;}
    return trade.targets.every((t,i)=>t&&t.label===expected[i].label&&t.rr===expected[i].rr&&t.price===expected[i].price&&t.mode==="SINGLE"&&
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
    return {eligible:eligible.length,legacy:entered.length-eligible.length,levels:[2].map((rr,i)=>{
      const rows=eligible.filter(t=>t.targets[i]).map(t=>({...t.targets[i],recovering:!!t.recovery?.pending})),hits=rows.filter(t=>t.status==="HIT").length,stopped=rows.filter(t=>t.status==="STOPPED").length;
      return {label:"TP"+(i+1),rr:2,mode:"SINGLE",eligible:rows.length,untracked:entered.length-rows.length,hits,stopped,resolved:hits+stopped,rate:hits+stopped?100*hits/(hits+stopped):null,
        recovering:rows.filter(t=>t.status==="PENDING"&&t.recovering).length,pending:rows.filter(t=>t.status==="PENDING"&&!t.recovering).length,review:rows.filter(t=>t.status==="REVIEW").length,
        unavailable:rows.filter(t=>t.status==="UNAVAILABLE").length};
    })};
  }
  const api={createSingle,stopPrice,hitStop,pending,valid,interrupt,quote,bar,stats};
  if(typeof module!=="undefined"&&module.exports)module.exports=api;root.TargetEngine=api;
})(typeof self!=="undefined"?self:globalThis);
