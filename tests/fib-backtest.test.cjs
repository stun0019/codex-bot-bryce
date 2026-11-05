const test=require('node:test'),assert=require('node:assert/strict'),B=require('../site/fib-backtest.js'),P=require('../site/paper-engine.js');
const{candidate,NOW}=require('./fib-fixtures.cjs');
const bar=(o,h,l,c)=>({openTime:NOW,closeTime:NOW+299999,open:o,high:h,low:l,close:c});
function setup(){const c=candidate(),m=P.createModel({version:1,trades:[],settings:{feeRate:.0005,slippage:.0002}});m.enableAccount(200,NOW);assert.equal(m.addCandidates([c],200,NOW),1);return {c,m,t:m.trades[0]};}
test('OHLC execution fills crossed targets with costs and trailing return exits',()=>{
 const {c,m,t}=setup();m.tryLimitFill(t,c.entry,NOW+1);B.executeBar(m,t,bar(c.entry,c.entry+.1,c.targets[1]-.1,c.targets[0]+.2));assert.equal(t.remainingQuantity,0);assert.equal(t.exitReason,'RETRACE_TP2');assert.equal(t.exitFills.length,3);assert.ok(t.netPnl>0);assert.equal(P.createModel(m.snapshot()).trades.length,1);
});
test('ambiguous OHLC bars choose the lower liquidation value rather than favorable target ordering',()=>{
 const {c,m,t}=setup();m.tryLimitFill(t,c.entry,NOW+1);const b=bar(c.entry,c.stopLoss+.1,c.targets[2]-.1,c.entry),a=B.replay(m,t,b,true),z=B.replay(m,t,b,false);assert.notEqual(a.score,z.score);assert.equal(B.executeBar(m,t,b),true);assert.equal(t.netPnl,Math.min(a.score,z.score));assert.equal(t.exitFills.length,1);assert.ok(t.netPnl<0);
});
test('quarter portfolio cannot enter before signal time and retains open equity without inventing a quarter-end close',()=>{
 const c=candidate(),d=300000,rows=Array.from({length:3},(_,i)=>[NOW+i*d,c.entry-.2,c.entry+.01,c.entry-.3,c.entry-.1,100,NOW+(i+1)*d-1]);
 const r=B.run({markets:[c.market],datasets:{[c.symbol]:{'5m':rows}},events:[{at:NOW+d,symbol:c.symbol,profileId:c.profileId,candidate:c}],start:NOW,end:NOW+3*d});
 assert.equal(r.trades.length,1);assert.equal(r.trades[0].openedAt,NOW+d);assert.equal(r.stats.closed,0);assert.equal(r.stats.open,1);assert.equal(r.account.initialCapital,200);assert.ok(r.account.balance<200);assert.equal(r.account.equity,r.account.balance+r.account.unrealizedPnl);assert.ok(r.account.usedRisk<=r.account.totalLimit+1e-7);
});
test('two simultaneous profiles share the same risk allowance instead of independent balances',()=>{
 const c=candidate(),other=candidate('1h5m'),rows=[[NOW,c.entry-.2,c.entry+.01,c.entry-.3,c.entry-.1,100,NOW+299999]];
 const r=B.run({markets:[c.market],datasets:{[c.symbol]:{'5m':rows}},events:[c,other].map(candidate=>({at:NOW,symbol:c.symbol,profileId:candidate.profileId,candidate})),start:NOW,end:NOW+300000});
 assert.equal(r.account.initialCapital,200);assert.ok(r.account.usedRisk<=10);assert.ok(r.trades.filter(t=>t.status==='OPEN').reduce((s,t)=>s+t.estimatedStopRisk,0)<=10+1e-7);assert.ok(r.blockedCandidates>=1);
});
