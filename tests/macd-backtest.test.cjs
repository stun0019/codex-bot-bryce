const test=require('node:test'),assert=require('node:assert/strict'),B=require('../site/macd-backtest.js'),P=require('../site/paper-engine.js'),M=require('../site/macd-engine.js'),{fixture,analyze,NOW}=require('./macd-fixtures.cjs');
function setup(){const c=analyze(fixture()).pending,m=P.createModel({version:1,trades:[],settings:{feeRate:.0005,slippage:.0002}});m.enableAccount(200,NOW);assert.equal(m.addCandidates([c],200,NOW),1);return{c,m,t:m.trades[0]};}
test('a fill bar crosses each newly active target at its own price',()=>{
 const{c,m,t}=setup(),bar={openTime:NOW,closeTime:NOW+299999,open:c.entry,low:c.entry-.01,high:c.targets[3]+.01,close:c.targets[3]},r=B.replay(m,t,bar,false);
 assert.equal(r.trade.exitFills.length,4);assert.deepEqual(r.trade.exitFills.map(f=>f.label),['TP1','TP2','TP3','TP4']);assert.ok(r.trade.exitFills[0].price<c.targets[1]);assert.equal(r.trade.remainingQuantity,0);assert.doesNotThrow(()=>P.createModel({...m.snapshot(),trades:[r.trade]}));
});
test('exact TP reversal exits next tick near the reached target, not the distant stop',()=>{
 const{c,m,t}=setup();m.tryLimitFill(t,c.entry,NOW+1);const bar={openTime:NOW,closeTime:NOW+299999,open:c.entry,high:c.targets[0],low:c.stopLoss-.01,close:c.entry},r=B.replay(m,t,bar,true);
 assert.equal(r.trade.exitReason,'RETRACE_TP1');assert.equal(r.trade.remainingQuantity,0);assert.ok(r.trade.exitFills.at(-1).price>c.stopLoss);assert.equal(r.trade.exitFills.length,2);
});
test('ambiguous bars choose lower marked result and never fill before confirmation',()=>{
 const{c,m,t}=setup(),bar={openTime:NOW,closeTime:NOW+299999,open:c.entry,high:c.targets[2]+.01,low:c.stopLoss-.01,close:c.entry},a=B.replay(m,t,bar,true),b=B.replay(m,t,bar,false);assert.equal(B.executeBar(m,t,bar),true);assert.equal(t.netPnl,Math.min(a.score,b.score));
 const rows=Array.from({length:5},(_,i)=>[NOW+i*300000,c.entry,c.entry+.1,c.entry-.01,c.entry,100,NOW+(i+1)*300000-1]);
 const later=structuredClone(c);later.confirmedAt+=900000;later.expiresAt+=900000;later.fib.confirm.openTime+=900000;later.fib.confirm.closeTime+=900000;later.fib.lowMacd.at+=900000;later.setupId=later.profileId+':'+later.direction+':'+later.fib.trigger.openTime+':'+later.fib.confirm.openTime;
 assert.equal(M.valid(later),true);const r=B.run({markets:[c.market],datasets:{[c.symbol]:{'5m':rows}},events:[{at:later.confirmedAt,symbol:c.symbol,profileId:c.profileId,candidate:later}],start:NOW,end:NOW+1500000,strategyVersion:M.VERSION});assert.ok(r.trades[0].openedAt>=later.confirmedAt);assert.equal(r.stats.open,1);assert.equal(r.stats.closed,0);assert.equal(r.account.initialCapital,200);
});
