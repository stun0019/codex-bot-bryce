const test=require('node:test'),assert=require('node:assert/strict'),R=require('../site/candidate-records.js'),P=require('../site/paper-engine.js'),F=require('../site/fib-engine.js'),T=require('../site/target-engine.js');
const{candidate,NOW}=require('./fib-fixtures.cjs');
test('Fib candidate records persist both profiles and mirror blocked candidates without reopening orders',()=>{
 const a=candidate(),b=candidate('1h5m','LONG');b.symbol=b.market.symbol='ETHUSDT';b.market.quoteVolume24h=1000;
 const data=new Map(),storage={getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v)},store=R.create(storage);assert.equal(store.update([a,b],NOW),true);assert.equal(R.create(storage).list().length,2);
 const m=P.createModel();m.enableAccount(200,NOW);assert.equal(m.addCandidates([b,a],200,NOW),1);const before=JSON.stringify(m.snapshot());
 const rows=R.paperRows(store.list(),m.trades,{now:NOW,currentKeys:new Set([a,b].map(P.key)),plans:m.previewCandidates([a,b],200,NOW)});assert.equal(rows.length,2);assert.equal(rows.filter(r=>r.status==='NOT_ENTERED').length,1);assert.equal(JSON.stringify(m.snapshot()),before);assert.ok(F.valid(a));
});
test('Fib target statistics preserve distinct variable levels and stop observing targets after retrace exit',()=>{
 const c=candidate(),m=P.createModel({version:1,settings:{feeRate:0,slippage:0},trades:[]});m.addCandidates([c],200,NOW);m.tick(c.symbol,c.entry,NOW+1,{aggregateId:100});m.tick(c.symbol,c.targets[0],NOW+2,{aggregateId:101});m.tick(c.symbol,c.targets[0]-.01,NOW+3,{aggregateId:102});m.tick(c.symbol,c.targets[0],NOW+4,{aggregateId:103});
 const stats=m.stats('fib');assert.equal(stats.targets.levels[0].mode,'FIB');assert.equal(stats.targets.levels[0].rr,null);assert.equal(stats.targets.levels[0].fibLevel,0);assert.equal(stats.targets.levels[0].rate,100);assert.equal(stats.targets.levels[1].stopped,1);assert.equal(stats.targets.levels[3].rate,0);
 m.tick(c.symbol,c.targets[3],NOW+5,{aggregateId:104});assert.equal(m.trades[0].targets[3].status,'STOPPED');assert.equal(T.pending(m.trades[0]),false);
 const empty=m.stats('fib:1h5m');assert.equal(empty.targets.levels[0].mode,'FIB');
});
