const test=require('node:test'),assert=require('node:assert/strict');
const P=require('../site/paper-engine.js');const NOW=1800000000000;
const candidate=(at)=>({symbol:'BTCUSDT',direction:'LONG',confirmedAt:at,expiresAt:at+900000,entry:100,stopLoss:98,target:104,tickSize:.01,market:{stepSize:.001,minQty:.001,minNotional:5}});
test('cleared ledger cutoff survives reload and blocks all pre-clear signals',()=>{
 const m=P.createModel({version:1,settings:{enabled:true,feeRate:.0005,slippage:.0002},trades:[],ignoreBefore:NOW});
 assert.equal(m.addCandidates([candidate(NOW-1000),candidate(NOW)],70,NOW+1000),0);
 const restored=P.createModel(JSON.parse(JSON.stringify(m.snapshot())));assert.equal(restored.addCandidates([candidate(NOW-1000)],70,NOW+2000),0);assert.equal(restored.trades.length,0);
 assert.equal(restored.addCandidates([candidate(NOW+900000)],70,NOW+901000),1);
});
test('clear cutoff preserves settings and does not mutate a prior ledger',()=>{
 const previous=P.createModel();previous.addCandidates([candidate(NOW-1000)],70,NOW);previous.tick('BTCUSDT',99,NOW+1,{aggregateId:100});const saved=JSON.stringify(previous.snapshot());
 const cleared=P.createModel({version:1,settings:{...previous.settings,enabled:false},trades:[],ignoreBefore:NOW+2000});
 assert.equal(cleared.trades.length,0);assert.equal(cleared.settings.enabled,false);assert.equal(cleared.settings.feeRate,previous.settings.feeRate);assert.equal(JSON.stringify(previous.snapshot()),saved);
});
test('malformed clear timestamps fail closed while old ledgers remain readable',()=>{
 assert.throws(()=>P.createModel({version:1,trades:[],ignoreBefore:'1800000000000'}),/清空時間/);assert.throws(()=>P.createModel({version:1,trades:[],ignoreBefore:-1}),/清空時間/);
 assert.equal(P.createModel({version:1,trades:[]}).snapshot().ignoreBefore,undefined);
});
