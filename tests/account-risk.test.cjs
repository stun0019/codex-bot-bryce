const test=require('node:test'),assert=require('node:assert/strict');
const E=require('../site/strategy-engine.js'),S=require('../site/smc-engine.js'),P=require('../site/paper-engine.js');
const {fixture}=require('./smc-fixtures.cjs');
const A=require('../site/account-risk.js');
function candidate(id='4h15m',symbol='BTCUSDT',direction='SHORT'){
 const f=fixture(id,direction),c=S.analyze(f.market,E.closedBars(f.higher,f.profile.high,f.confirmedAt),E.closedBars(f.lower.slice(0,37),f.profile.low,f.confirmedAt),f.confirmedAt,200,id).pending;
 c.symbol=c.market.symbol=symbol;c.market.quoteVolume24h=symbol==='BTCUSDT'?10000:1000;return c;
}
function model(c){const m=P.createModel({version:1,settings:{enabled:true,feeRate:.0005,slippage:.0002},trades:[]});m.enableAccount(200,c.confirmedAt);return m;}

test('invalid financial marks and saved limits beyond the approved caps fail closed',()=>{
 const c=candidate(),m=model(c);m.addCandidates([c],200,c.confirmedAt);m.tick(c.symbol,c.entry,c.confirmedAt+1,{aggregateId:100});m.trades[0].lastPrice=NaN;
 const state=m.accountState(c.confirmedAt+1);assert.ok(state.blockedReason);assert.equal(A.plan(c,m.settings,state).ok,false);
 const saved=m.snapshot();saved.account.limits.totalRisk=.1;assert.throws(()=>A.validate(saved.account,saved.trades),/無效/);saved.account.limits.totalRisk=.05;saved.account.limits.leverage=75;assert.throws(()=>A.validate(saved.account,saved.trades),/無效/);
});
test('two timeframe signals and opposite directions share the same 5% reservation ceiling',()=>{
 const a=candidate(),b={...candidate('1h5m','ETHUSDT','LONG'),confirmedAt:a.confirmedAt,expiresAt:a.expiresAt};const m=model(a),before=JSON.stringify(m.snapshot());
 const preview=m.previewCandidates([b,a],200,a.confirmedAt);assert.equal(JSON.stringify(m.snapshot()),before);assert.equal(preview.get(P.key(a)).ok,true);assert.equal(preview.get(P.key(b)).ok,false);
 assert.equal(m.addCandidates([b,a],200,a.confirmedAt),1);assert.equal(m.trades[0].symbol,'BTCUSDT');assert.ok(m.accountState(a.confirmedAt).usedRisk<=10);assert.equal(m.trades[0].reservedPlan.quantity,preview.get(P.key(a)).quantity);
});
test('card reservation and fill use identical fee-aware quantity and partial-lot validation',()=>{
 const c=candidate(),m=model(c),p=m.previewCandidates([c],200,c.confirmedAt).get(P.key(c));m.addCandidates([c],200,c.confirmedAt);m.tick(c.symbol,c.entry,c.confirmedAt+1,{aggregateId:100});
 const t=m.trades[0];assert.equal(t.status,'OPEN');assert.equal(t.quantity,p.quantity);assert.equal(t.estimatedStopRisk,p.risk);assert.deepEqual(t.exitLegs.map(l=>l.quantity),p.exitQuantities);assert.ok(t.estimatedStopRisk<=10);
 assert.ok(Math.abs(m.accountState(c.confirmedAt+1).balance-(200-t.entryFee))<1e-9);
 const small={...c,market:{...c.market,stepSize:10,minQty:10}};assert.equal(m.previewCandidates([small],200,c.confirmedAt+1).get(P.key(small)).ok,true); // same recorded setup retains its frozen plan
 const fresh={...small,setupId:'different',confirmedAt:c.confirmedAt+100};assert.equal(E.position(fresh,fresh.market,200).ok,false);
});
test('partial exits release remaining-position margin and risk while cash is booked once',()=>{
 const c=candidate(),m=model(c);m.addCandidates([c],200,c.confirmedAt);m.tick(c.symbol,c.entry,c.confirmedAt+1,{aggregateId:100});const t=m.trades[0],initial=m.accountState(c.confirmedAt+1);
 m.tick(c.symbol,t.targets[0].price,c.confirmedAt+1000,{aggregateId:101});const partial=m.accountState(c.confirmedAt+1000);assert.ok(partial.usedRisk<initial.usedRisk);assert.ok(partial.positionMargin<initial.positionMargin);assert.ok(partial.balance>initial.balance);
 const saved=m.snapshot(),restored=P.createModel(saved);assert.deepEqual(restored.accountState(c.confirmedAt+1000),partial);restored.tick(c.symbol,t.targets[0].price,c.confirmedAt+1000,{aggregateId:101});assert.equal(restored.accountState(c.confirmedAt+1000).balance,partial.balance);
 const second={...candidate('1h5m','ETHUSDT','LONG'),confirmedAt:c.confirmedAt+1000,expiresAt:c.expiresAt};assert.equal(m.addCandidates([second],200,c.confirmedAt+1000),1);assert.ok(m.accountState(c.confirmedAt+1000).usedRisk<=m.accountState(c.confirmedAt+1000).totalLimit+1e-8);
});
test('old independent closed PnL is not retroactively credited and existing open exposure is reserved',()=>{
 const c=candidate(),old=P.createModel({version:1,settings:{enabled:true,feeRate:0,slippage:0},trades:[]});old.addCandidates([c],200,c.confirmedAt);old.tick(c.symbol,c.entry,c.confirmedAt+1,{aggregateId:100});old.tick(c.symbol,80,c.confirmedAt+1000,{aggregateId:101});
 assert.ok(old.trades[0].netPnl>0);old.enableAccount(200,c.confirmedAt+2000);assert.equal(old.accountState(c.confirmedAt+2000).balance,200);
 const open=P.createModel({version:1,settings:{enabled:true,feeRate:0,slippage:0},trades:[]});open.addCandidates([c],200,c.confirmedAt);open.tick(c.symbol,c.entry,c.confirmedAt+1,{aggregateId:100});open.enableAccount(200,c.confirmedAt+2);assert.ok(open.accountState(c.confirmedAt+2).positionMargin>0);assert.ok(open.accountState(c.confirmedAt+2).usedRisk>0);
});
test('unverified existing positions block new plans and reserve exposure across refresh',()=>{
 const c=candidate(),m=model(c);m.addCandidates([c],200,c.confirmedAt);m.tick(c.symbol,c.entry,c.confirmedAt+1,{aggregateId:100});m.suspend('refresh',c.confirmedAt+10);
 const second={...candidate('1h5m','ETHUSDT','LONG'),confirmedAt:c.confirmedAt+10,expiresAt:c.expiresAt};assert.match(m.previewCandidates([second],200,c.confirmedAt+10).get(P.key(second)).reason,/待核對/);assert.equal(m.addCandidates([second],200,c.confirmedAt+10),0);
 const saved=m.snapshot();saved.account.limits.totalRisk=-1;assert.throws(()=>P.createModel(saved),/帳戶/);
});
test('a changed account is rechecked before a reserved limit fill and cannot silently upsize',()=>{
 const c=candidate(),m=model(c);m.addCandidates([c],200,c.confirmedAt);const t=m.trades[0],q=t.reservedPlan.quantity;
 // An extreme adverse gap after accepting the order must not create a bigger quantity.
 m.tick(c.symbol,t.stopLoss+1,c.confirmedAt+1,{aggregateId:100});assert.equal(t.status,'SKIPPED');assert.equal(t.quantity,undefined);assert.equal(t.reservedPlan.quantity,q);assert.equal(m.accountState(c.confirmedAt+1).usedRisk,0);
});
test('gross risk is not netted between long and short and margin shortage downsizes the same plan',()=>{
 const c=candidate(),m=model(c),snapshot=m.snapshot();snapshot.account.limits.leverage=1;const low=P.createModel(snapshot),p=low.previewCandidates([c],200,c.confirmedAt).get(P.key(c));assert.ok(p.ok);assert.ok(p.marginReserve<=200+1e-8);assert.ok(p.quantity<E.position(c,c.market,200).quantity);
 low.addCandidates([c],200,c.confirmedAt);assert.equal(low.trades[0].reservedPlan.quantity,p.quantity);
});
