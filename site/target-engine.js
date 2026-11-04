(function(root){
  "use strict";
  const E=root.StrategyEngine||(typeof require==="function"?require("./strategy-engine.js"):null);
  const STATES=new Set(["PENDING","HIT","STOPPED","REVIEW","UNAVAILABLE"]);
  function create(entry,stop,direction,tick){
    const long=direction==="LONG",distance=Math.abs(entry-stop);
    return [2,3,4].map((rr,index)=>{
      let price=E.quantize(entry+(long?1:-1)*rr*distance,tick,long?"ceil":"floor");
      if(Math.abs(price-entry)/distance<rr)price=Number((price+(long?tick:-tick)).toFixed(Math.min(14,E.decimals(tick))));
      const valid=Number.isFinite(price)&&price>0&&distance>0&&(long?price>entry:price<entry);
      return {label:"TP"+(index+1),rr,price:valid?price:null,status:valid?"PENDING":"UNAVAILABLE"};
    });
  }
  const pending=trade=>Array.isArray(trade.targets)&&trade.targets.some(t=>t.status==="PENDING");
  function valid(trade){
    if(trade.targets===undefined)return true; // Legacy records are preserved, never backfilled.
    if(!Array.isArray(trade.targets)||trade.targets.length!==3||!(trade.entry>0)||!Number.isFinite(trade.targetsLastQuoteAt))return false;
    const expected=create(trade.entry,trade.stopLoss,trade.direction,trade.tickSize);
    return trade.targets.every((t,i)=>t&&t.label===expected[i].label&&t.rr===expected[i].rr&&t.price===expected[i].price&&
      STATES.has(t.status)&&(t.price===null?t.status==="UNAVAILABLE":t.status!=="UNAVAILABLE")&&
      (!["HIT","STOPPED","REVIEW"].includes(t.status)||Number.isFinite(t.at)));
  }
  function interrupt(trade,reason,at){
    if(!pending(trade))return false;
    for(const target of trade.targets)if(target.status==="PENDING")Object.assign(target,{status:"REVIEW",reason,at});return true;
  }
  function quote(trade,price,at){
    const long=trade.direction==="LONG",stopped=long?price<=trade.stopLoss:price>=trade.stopLoss;
    for(const target of trade.targets||[])if(target.status==="PENDING"&&(stopped||(long?price>=target.price:price<=target.price)))
      Object.assign(target,{status:stopped?"STOPPED":"HIT",at,observedPrice:price});
  }
  function bar(trade,candle,policy){
    const long=trade.direction==="LONG",gapStop=long?candle.open<=trade.stopLoss:candle.open>=trade.stopLoss;
    const stop=long?candle.low<=trade.stopLoss:candle.high>=trade.stopLoss;
    for(const target of trade.targets||[])if(target.status==="PENDING"){
      const gapHit=long?candle.open>=target.price:candle.open<=target.price,hit=long?candle.high>=target.price:candle.low<=target.price;
      if(!hit&&!stop)continue;
      const ambiguous=!gapStop&&!gapHit&&hit&&stop;
      Object.assign(target,{status:gapStop?"STOPPED":gapHit?"HIT":ambiguous&&policy==="review"?"REVIEW":stop?"STOPPED":"HIT",
        at:gapStop||gapHit?candle.openTime:candle.closeTime+1,barTime:candle.openTime,ambiguous});
    }
  }
  function stats(trades){
    const entered=trades.filter(t=>t.entry>0&&t.quantity>0),eligible=entered.filter(t=>Array.isArray(t.targets));
    return {eligible:eligible.length,legacy:entered.length-eligible.length,levels:[2,3,4].map((rr,i)=>{
      const rows=eligible.map(t=>({...t.targets[i],recovering:!!t.recovery?.pending})),hits=rows.filter(t=>t.status==="HIT").length,stopped=rows.filter(t=>t.status==="STOPPED").length;
      return {label:"TP"+(i+1),rr,hits,stopped,resolved:hits+stopped,rate:hits+stopped?100*hits/(hits+stopped):null,
        recovering:rows.filter(t=>t.status==="PENDING"&&t.recovering).length,pending:rows.filter(t=>t.status==="PENDING"&&!t.recovering).length,review:rows.filter(t=>t.status==="REVIEW").length,
        unavailable:rows.filter(t=>t.status==="UNAVAILABLE").length};
    })};
  }
  const api={create,pending,valid,interrupt,quote,bar,stats};
  if(typeof module!=="undefined"&&module.exports)module.exports=api;root.TargetEngine=api;
})(typeof self!=="undefined"?self:globalThis);
