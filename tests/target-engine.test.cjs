const test=require('node:test'),assert=require('node:assert/strict');
const E=require('../site/strategy-engine.js'),T=require('../site/target-engine.js'),P=require('../site/paper-engine.js'),B=require('../site/bt-engine.js');
const {NOW,rows,market}=require('./strategy-fixtures.cjs');
function model(){return P.createModel({version:1,settings:{enabled:true,feeRate:0,slippage:0},trades:[]});}
function open(m,direction='LONG'){
 const c={symbol:'BTCUSDT',direction,confirmedAt:NOW-1,expiresAt:NOW+900000,entry:100,stopLoss:direction==='LONG'?98:102,target:direction==='LONG'?104:96,tickSize:.01,market:market()};
 m.addCandidates([c],70,NOW);m.tick('BTCUSDT',100,NOW+1);return m.trades.at(-1);
}
const states=t=>t.targets.map(t=>t.status);
function fixture(policy='stop-first'){
 const start=Math.floor(NOW/900000)*900000,fifteen=rows('15m');
 for(const [i,o,h,l,c]of[[0,100,101,99,100],[1,100,116,99,110],[2,110,126,109,120]])fifteen.push([start+i*900000,o,h,l,c,100,start+(i+1)*900000-1,10000]);
 return{config:{start,end:start+2700000,capital:70,feeRate:0,slippage:0,mode:'fixed',ambiguous:policy},markets:[market()],datasets:{BTCUSDT:{'15m':fifteen,'4h':rows('4h')}}};
}
test('reference and fill target levels are 2R/3R/4R for both directions and round away from entry',()=>{
 for(const direction of ['LONG','SHORT']){const entry=100,stop=direction==='LONG'?98.97:101.03;
  const levels=T.create(entry,stop,direction,.1);assert.deepEqual(levels.map(t=>t.price),E.targets(entry,stop,direction,.1));
  levels.forEach((t,i)=>assert.ok(Math.abs(t.price-entry)/Math.abs(entry-stop)>=i+2));
 }
});
test('forward target observations continue after primary target closes without rewriting its PnL',()=>{
 const m=model(),t=open(m);m.tick(t.symbol,104,NOW+1000);const pnl=t.netPnl;
 assert.equal(t.status,'TAKE_PROFIT');assert.deepEqual(states(t),['HIT','PENDING','PENDING']);assert.deepEqual(m.activeSymbols(),['BTCUSDT']);
 m.tick(t.symbol,106,NOW+2000);m.tick(t.symbol,108,NOW+3000);
 assert.deepEqual(states(t),['HIT','HIT','HIT']);assert.equal(t.netPnl,pnl);assert.deepEqual(m.activeSymbols(),[]);
});
test('a later stop ends remaining targets and subsequent recovery never adds hits',()=>{
 const m=model(),t=open(m);m.tick(t.symbol,104,NOW+1000);m.tick(t.symbol,98,NOW+2000);m.tick(t.symbol,120,NOW+3000);
 assert.deepEqual(states(t),['HIT','STOPPED','STOPPED']);assert.equal(t.status,'TAKE_PROFIT');
});
test('short quotes can touch several nested targets on one observed tick',()=>{
 const m=model(),t=open(m,'SHORT');m.tick(t.symbol,92,NOW+1000);assert.deepEqual(t.targets.map(t=>t.price),[96,94,92]);assert.deepEqual(states(t),['HIT','HIT','HIT']);
});
test('a quote gap after primary exit reviews only the unresolved targets',()=>{
 const m=model(),t=open(m);m.tick(t.symbol,104,NOW+1000);m.tick(t.symbol,108,NOW+32000);
 assert.deepEqual(states(t),['HIT','REVIEW','REVIEW']);assert.equal(t.status,'TAKE_PROFIT');assert.equal(T.stats(m.trades).levels[1].rate,null);
});
test('reload interruption and expiration preserve hit results and completed primary trades',()=>{
 for(const mode of ['reload','expiry']){const m=model(),t=open(m);m.tick(t.symbol,104,NOW+1000);const restored=P.createModel(JSON.parse(JSON.stringify(m.snapshot())));
  if(mode==='reload')restored.interrupt('reload',NOW+2000);else restored.expire(NOW+32000);
  assert.deepEqual(states(restored.trades[0]),['HIT','REVIEW','REVIEW']);assert.equal(restored.trades[0].status,'TAKE_PROFIT');assert.deepEqual(restored.activeSymbols(),[]);
 }
});
test('out-of-order target quotes cannot create a hit after a newer observation',()=>{
 const m=model(),t=open(m);m.tick(t.symbol,104,NOW+1000);m.tick(t.symbol,105,NOW+5000);m.tick(t.symbol,108,NOW+2000);
 assert.deepEqual(states(t),['HIT','PENDING','PENDING']);
});
test('legacy trades remain readable and are never assigned invented target observations',()=>{
 const m=model(),t=open(m);m.tick(t.symbol,104,NOW+1000);const saved=JSON.parse(JSON.stringify(m.snapshot()));delete saved.trades[0].targets;delete saved.trades[0].targetsLastQuoteAt;
 const old=P.createModel(saved);assert.equal(old.trades[0].targets,undefined);assert.equal(old.stats().targets.legacy,1);assert.equal(old.stats().targets.eligible,0);
});
test('malformed restored target prices are rejected',()=>{
 const m=model();open(m);const saved=JSON.parse(JSON.stringify(m.snapshot()));saved.trades[0].targets[2].price=101;
 assert.throws(()=>P.createModel(saved),/無效/);
});
test('hit-rate denominator excludes pending, review, unavailable and legacy samples',()=>{
 const m=model(),hit=open(m);m.tick(hit.symbol,104,NOW+1000);
 const stopped={...hit,targets:T.create(100,98,'LONG',.01)};T.quote(stopped,98,NOW+2000);
 const pending={...hit,targets:T.create(100,98,'LONG',.01)},review={...pending,targets:T.create(100,98,'LONG',.01)};T.interrupt(review,'gap',NOW+2000);
 const legacy={...hit};delete legacy.targets;
 const stats=T.stats([hit,stopped,pending,review,legacy]);assert.equal(stats.levels[0].rate,50);assert.equal(stats.levels[0].resolved,2);assert.equal(stats.levels[0].pending,1);assert.equal(stats.levels[0].review,1);assert.equal(stats.legacy,1);
 assert.equal(T.create(10,20,'SHORT',.1)[0].status,'UNAVAILABLE');
});
test('historical target tracking reaches TP2/TP3 on bars after primary profit has already closed',()=>{
 const report=B.run(fixture()),t=report.trades[0];assert.equal(t.status,'TAKE_PROFIT');assert.deepEqual(states(t),['HIT','HIT','HIT']);
 assert.ok(t.targets[2].at>t.closedAt);assert.equal(report.stats.targets.levels[2].rate,100);assert.equal(B.groups(report.trades,'symbol')[0].targets.levels[2].hits,1);
});
test('historical stop after TP1 preserves TP1 and marks TP2/TP3 stopped',()=>{
 const f=fixture();Object.assign(f.datasets.BTCUSDT['15m'].at(-1),{1:110,2:111,3:90,4:100});
 const t=B.run(f).trades[0];assert.equal(t.status,'TAKE_PROFIT');assert.deepEqual(states(t),['HIT','STOPPED','STOPPED']);
});
test('historical unresolved targets at period end remain pending, excluded from the resolved rate',()=>{
 const f=fixture();Object.assign(f.datasets.BTCUSDT['15m'].at(-1),{1:110,2:111,3:109,4:110});
 const report=B.run(f);assert.deepEqual(states(report.trades[0]),['HIT','PENDING','PENDING']);assert.equal(report.stats.targets.levels[1].rate,null);assert.equal(report.stats.targets.levels[1].pending,1);
});
test('historical same-bar ambiguity applies independently to each target',()=>{
 for(const policy of ['stop-first','review']){const f=fixture(policy);Object.assign(f.datasets.BTCUSDT['15m'].at(-3),{2:126,3:90});
  assert.deepEqual(states(B.run(f).trades[0]),Array(3).fill(policy==='review'?'REVIEW':'STOPPED'));
 }
});
test('historical opening gap target is hit before a later intrabar stop',()=>{
 const trade={entry:100,stopLoss:98,direction:'LONG',targets:T.create(100,98,'LONG',.01)};
 T.bar(trade,{open:106,high:106,low:97,openTime:NOW,closeTime:NOW+900000-1},'review');
 assert.deepEqual(states(trade),['HIT','HIT','STOPPED']);
});
