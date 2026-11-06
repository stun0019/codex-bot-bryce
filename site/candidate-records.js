(function(root){
  "use strict";
  const Single=root.SmcEntry||(typeof require==='function'?require('./smc-entry.js'):null),P=root.PaperEngine||(typeof require==='function'?require('./paper-engine.js'):null);
  const KEY="codex-smc-2r-card-records-v1",LIMIT=200,finite=Number.isFinite;
  function valid(c){return Single.valid(c)&&c.market?.symbol===c.symbol&&c.market.stepSize>0;}
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
    const candidates=records.filter(r=>Single.isSingle(r.candidate)&&!ids.has(P.key(r.candidate))).map(({candidate:c,seenAt})=>{
      const id=P.key(c),plan=plans.get(id),current=currentKeys.has(id)&&c.expiresAt>now;
      return {...c,id,entry:undefined,targets:undefined,referenceEntry:c.entry,plannedTargets:[...c.targets],detectedAt:seenAt,status:"NOT_ENTERED",recordOnly:true,
        reason:c.expiresAt<=now?"候選已到期，未成交":current?(plan?.reason||"等待共用帳戶預留；尚未成交"):"保留候選紀錄，未建立模擬部位"};
    });
    return [...trades,...candidates].sort((a,b)=>a.detectedAt-b.detectedAt||a.id.localeCompare(b.id));
  }
  const api={KEY,LIMIT,valid,merge,create,paperRows};if(typeof module!=="undefined"&&module.exports)module.exports=api;root.CandidateRecords=api;
})(typeof window!=="undefined"?window:globalThis);
