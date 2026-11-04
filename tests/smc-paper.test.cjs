const test=require('node:test'),assert=require('node:assert/strict'),E=require('../site/strategy-engine.js'),S=require('../site/smc-engine.js'),P=require('../site/paper-engine.js');
const {fixture}=require('./smc-fixtures.cjs');
function setup(id='4h15m',direction='SHORT',costs={feeRate:0,slippage:0}){const f=fixture(id,direction),c=S.analyze(f.market,E.closedBars(f.higher,f.profile.high,f.confirmedAt),E.closedBars(f.lower.slice(0,37),f.profile.low,f.confirmedAt),f.confirmedAt,200,id).pending;
 const m=P.createModel({version:1,settings:{enabled:true,...costs},trades:[]});m.addCandidates([c],200,c.confirmedAt);return{m,c,t:m.trades[0],at:c.confirmedAt};}
function fill(s){s.m.tick(s.c.symbol,s.c.entry,s.at+1,{aggregateId:100});return s.t;}
test('SMC waits for the OB midpoint and independently identifies simultaneous timeframe setups',()=>{
 const s=setup();s.m.tick(s.c.symbol,s.c.entry-1,s.at+1,{aggregateId:99});assert.equal(s.t.status,'WAITING_PRICE');
 s.m.tick(s.c.symbol,s.c.entry,s.at+2,{aggregateId:100});assert.equal(s.t.status,'OPEN');assert.equal(s.t.entry,s.c.entry);assert.equal(s.t.budget,10);
 const other={...s.c,profileId:'1h5m',timeframeLabel:'1H＋5M'};assert.equal(s.m.addCandidates([other],200,s.at+3),1);assert.notEqual(s.m.trades[0].id,s.m.trades[1].id);
 assert.equal(P.createModel(s.m.snapshot()).trades.length,2);
});
test('TP1/TP2 reduce 30% of original quantity, TP3 closes the rest, TP4 cannot change PnL',()=>{
 for(const direction of ['SHORT','LONG']){const s=setup('4h15m',direction),t=fill(s),initial=t.quantity;
  s.m.tick(t.symbol,t.targets[0].price,s.at+1000,{aggregateId:101});assert.equal(t.status,'OPEN');assert.ok(t.remainingQuantity<initial);assert.equal(t.exitFills.length,1);
  s.m.tick(t.symbol,t.targets[1].price,s.at+2000,{aggregateId:102});assert.equal(t.exitFills.length,2);assert.equal(t.exitFills[0].quantity,t.exitFills[1].quantity);
  s.m.tick(t.symbol,t.targets[2].price,s.at+3000,{aggregateId:103});assert.equal(t.status,'TAKE_PROFIT');assert.equal(t.remainingQuantity,0);assert.equal(t.exitFills.length,3);
  assert.ok(Math.abs(t.exitFills.reduce((n,f)=>n+f.quantity,0)-initial)<1e-10);const pnl=t.netPnl;
  s.m.tick(t.symbol,t.targets[3].price,s.at+4000,{aggregateId:104});assert.equal(t.netPnl,pnl);assert.equal(t.exitFills.length,3);assert.equal(t.targets[3].status,'HIT');assert.equal(s.m.stats().closed,1);
 }
});
test('a stop after TP2 closes only the remaining amount and can still be a net winning trade',()=>{
 const s=setup(),t=fill(s);s.m.tick(t.symbol,t.targets[1].price,s.at+1000,{aggregateId:101});assert.equal(t.exitFills.length,2);
 s.m.tick(t.symbol,t.stopLoss,s.at+2000,{aggregateId:102});assert.equal(t.status,'STOP_LOSS');assert.equal(t.remainingQuantity,0);assert.ok(t.netPnl>0);assert.equal(s.m.stats().wins,1);assert.equal(t.exitFills[2].label,'STOP');
});
test('partial costs are charged on executed quantities and estimated full-stop risk stays within 5%',()=>{
 const s=setup('4h15m','SHORT',{feeRate:.0005,slippage:.0002}),t=fill(s);assert.ok(t.estimatedStopRisk<=10);
 s.m.tick(t.symbol,t.targets[2].price,s.at+1000,{aggregateId:101});assert.equal(t.status,'TAKE_PROFIT');
 const gross=t.exitFills.reduce((n,f)=>n+(t.entry-f.price)*f.quantity,0),fees=t.exitFills.reduce((n,f)=>n+f.fee,0)+t.entryFee;
 assert.ok(Math.abs(t.netPnl-(gross-fees))<1e-8);assert.equal(P.createModel(s.m.snapshot()).trades[0].netPnl,t.netPnl);
});
test('refresh recovery restores partial quantities and does not execute a completed leg twice',()=>{
 const s=setup(),t=fill(s);s.m.tick(t.symbol,t.targets[0].price,s.at+1000,{aggregateId:101});const restored=P.createModel(s.m.snapshot()),r=restored.trades[0];
 restored.suspend('refresh',s.at+2000);const anchor={...r.checkpoint},rows=[anchor,{id:102,at:s.at+3000,price:r.targets[1].price},{id:103,at:s.at+4000,price:r.targets[2].price}];
 restored.applyRecovery({symbol:r.symbol,anchor,head:rows.at(-1),rows,complete:true},s.at+5000);
 assert.equal(r.remainingQuantity,0);assert.equal(r.exitFills.length,3);assert.equal(r.exitFills[0].source,'live');assert.equal(r.exitFills[1].source,'reconciled');
 const pnl=r.netPnl;restored.tick(r.symbol,r.targets[2].price,s.at+4000,{aggregateId:103});assert.equal(r.exitFills.length,3);assert.equal(r.netPnl,pnl);
});
test('waiting limits expire or skip on lost proof instead of backfilling entry after refresh',()=>{
 const s=setup();s.m.suspend('refresh',s.at+100);assert.equal(s.t.status,'SKIPPED');
 const b=setup();b.m.tick(b.t.symbol,b.c.entry-1,b.at+1,{aggregateId:100});b.m.tick(b.t.symbol,b.c.entry,b.at+1000,{aggregateId:102});assert.equal(b.t.status,'SKIPPED');
});
test('timeframe statistics separate new profiles from legacy records without rewriting old plans',()=>{
 const s=setup();fill(s);assert.equal(s.m.stats('4h15m').open,1);assert.equal(s.m.stats('1h5m').open,0);assert.equal(s.m.stats('legacy').open,0);
 const raw=JSON.parse(JSON.stringify(s.m.snapshot()));raw.trades[0].remainingQuantity+=1;assert.throws(()=>P.createModel(raw),/無效/);
});
