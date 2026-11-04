(function(root){
  "use strict";
  const S=root.SmcEngine||(typeof require==="function"?require("./smc-engine.js"):null);
  const EMA=root.EmaEngine||(typeof require==="function"?require("./ema-engine.js"):null);
  const FIB=root.FibEngine||(typeof require==="function"?require("./fib-engine.js"):null);
  const P=root.PaperEngine||(typeof require==="function"?require("./paper-engine.js"):null);
  const KEY="codex-smc-card-records-v1",LIMIT=200,finite=Number.isFinite;
  function valid(c){
    return c&&/^[A-Z0-9]+USDT$/.test(c.symbol)&&(S.isVersion(c.strategyVersion)||EMA.isVersion(c.strategyVersion)||FIB.isVersion(c.strategyVersion))&&S.PROFILES[c.profileId]&&["LONG","SHORT"].includes(c.direction)&&typeof c.setupId==="string"&&
      [c.entry,c.stopLoss,c.target,c.tickSize,c.stepSize,c.confirmedAt,c.expiresAt].every(n=>finite(n)&&n>0)&&c.market&&c.market.symbol===c.symbol&&c.market.stepSize>0&&
      Array.isArray(c.targets)&&c.targets.length===4&&c.targets.every(n=>finite(n)&&n>0)&&(FIB.isVersion(c.strategyVersion)?FIB.valid(c):EMA.isVersion(c.strategyVersion)?c.entryType==="LIMIT_CONFIRM"&&c.emaTrend&&[c.emaTrend.ema20,c.emaTrend.ema60,c.emaTrend.ema200].every(finite)&&c.pullback&&finite(c.pullback.ema20):[c.highZone,c.entryZone].every(z=>z&&finite(z.low)&&finite(z.high)&&z.low>0&&z.high>=z.low))&&
      (!c.macd||(finite(c.macd.dif)&&["LONG","SHORT",null].includes(c.macd.direction)))&&
      (!c.entryFilter?.enabled||(finite(c.entryFilter.rsi)&&finite(c.entryFilter.volumeRatio)));
  }
  function merge(previous,candidates,at=Date.now()){
    const rows=new Map(previous.filter(r=>valid(r.candidate)&&finite(r.seenAt)).map(r=>[P.key(r.candidate),r]));
    for(const c of candidates){if(!valid(c))continue;const {plan,...data}=c;rows.set(P.key(c),{candidate:JSON.parse(JSON.stringify(data)),seenAt:at});}
    return [...rows.values()].sort((a,b)=>b.seenAt-a.seenAt||b.candidate.confirmedAt-a.candidate.confirmedAt||P.key(a.candidate).localeCompare(P.key(b.candidate))).slice(0,LIMIT);
  }
  function create(storage){
    let records=[],error="";
    try{const raw=storage.getItem(KEY);if(raw){const saved=JSON.parse(raw);if(saved.version!==1||!Array.isArray(saved.records)||saved.records.some(r=>!valid(r.candidate)||!finite(r.seenAt)))throw Error("候選紀錄格式無效");records=merge(saved.records,[]);}}catch(e){error=e.message;}
    function persist(){try{storage.setItem(KEY,JSON.stringify({version:1,records}));error="";return true;}catch(e){error=e.message;return false;}}
    return {list:()=>records.map(r=>({...r,candidate:JSON.parse(JSON.stringify(r.candidate))})),getError:()=>error,
      update(candidates,at){records=merge(records,candidates,at);return persist();},clear(){records=[];return persist();}};
  }
  function paperRows(records,trades,{now=Date.now(),currentKeys=new Set(),plans=new Map()}={}){
    const ids=new Set(trades.map(t=>t.id));
    const candidates=records.filter(r=>(FIB.isVersion(r.candidate.strategyVersion)||EMA.isVersion(r.candidate.strategyVersion))&&!ids.has(P.key(r.candidate))).map(({candidate:c,seenAt})=>{
      const id=P.key(c),plan=plans.get(id),current=currentKeys.has(id)&&c.expiresAt>now;
      return {...c,id,entry:undefined,targets:undefined,referenceEntry:c.entry,plannedTargets:[...c.targets],detectedAt:seenAt,status:"NOT_ENTERED",recordOnly:true,
        reason:c.expiresAt<=now?"候選已到期，未成交":current?(plan?.reason||"等待共用帳戶預留；尚未成交"):"保留候選紀錄，未建立模擬部位"};
    });
    return [...trades,...candidates].sort((a,b)=>a.detectedAt-b.detectedAt||a.id.localeCompare(b.id));
  }
  const api={KEY,LIMIT,valid,merge,create,paperRows};if(typeof module!=="undefined"&&module.exports)module.exports=api;root.CandidateRecords=api;
})(typeof window!=="undefined"?window:globalThis);
