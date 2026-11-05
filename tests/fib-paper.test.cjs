const test=require('node:test'),assert=require('node:assert/strict'),P=require('../site/paper-engine.js'),T=require('../site/target-engine.js'),E=require('../site/strategy-engine.js');
const{candidate,NOW}=require('./fib-fixtures.cjs');
function setup(direction='SHORT',fees=0){const c=candidate('4h15m',direction),m=P.createModel({version:1,settings:{enabled:true,feeRate:fees,slippage:fees? .0002:0},trades:[]});assert.ok(c);m.enableAccount(200,NOW);assert.equal(m.addCandidates([c],200,NOW),1);m.tick(c.symbol,c.entry,NOW+1,{aggregateId:100});assert.equal(m.trades[0].status,'OPEN');return{c,m,t:m.trades[0],next:101};}
function tick(s,price){const id=s.next++;s.m.tick(s.c.symbol,price,NOW+id,{aggregateId:id});}
test('four exits use 20/30/30/remainder and custom Fib prices rather than fixed R targets',()=>{
 for(const direction of ['LONG','SHORT']){const s=setup(direction),t=s.t,q=t.quantity;assert.deepEqual(t.exitLegs.map(l=>l.quantity),E.partialQuantities(q,t.market.stepSize,[.2,.3,.3,.2]));assert.deepEqual(t.targets.map(l=>l.price),s.c.targets);
  for(let i=0;i<4;i++){tick(s,s.c.targets[i]);assert.equal(t.exitFills.length,i+1);assert.equal(t.exitGuard.label,'TP'+(i+1));assert.equal(t.status,i===3?'TAKE_PROFIT':'OPEN');assert.equal(P.createModel(s.m.snapshot()).trades.length,1);}
  assert.equal(t.remainingQuantity,0);assert.equal(T.pending(t),false);assert.deepEqual(t.targets.map(l=>l.status),['HIT','HIT','HIT','HIT']);
 }
});
test('a return to each attained target closes all remaining quantity before the next target',()=>{
 for(const direction of ['LONG','SHORT'])for(let attained=1;attained<=3;attained++){const s=setup(direction),t=s.t;
  for(let i=0;i<attained;i++)tick(s,s.c.targets[i]);const guard=s.c.targets[attained-1],remaining=t.remainingQuantity;
  tick(s,guard+(direction==='LONG'?.01:-.01));assert.equal(t.status,'OPEN');tick(s,guard);
  assert.equal(t.status,'STOP_LOSS');assert.equal(t.exitReason,'RETRACE_TP'+attained);assert.equal(t.exitFills.at(-1).quantity,remaining);assert.equal(t.remainingQuantity,0);assert.equal(T.pending(t),false);assert.ok(t.netPnl>0);assert.equal(s.m.stats('fib').wins,1);assert.equal(P.createModel(s.m.snapshot()).trades.length,1);
 }
});
test('the initial touch, duplicate aggregate and repeated same-price quote cannot immediately flatten the position',()=>{
 const s=setup(),tp=s.c.targets[0];tick(s,tp);const remaining=s.t.remainingQuantity;assert.ok(remaining>0);
 s.m.tick(s.c.symbol,tp,NOW+200,{aggregateId:101});assert.equal(s.t.remainingQuantity,remaining);tick(s,tp);assert.equal(s.t.status,'OPEN');assert.equal(s.t.remainingQuantity,remaining);
 tick(s,tp+.01);assert.equal(s.t.remainingQuantity,0);assert.equal(s.t.exitReason,'RETRACE_TP1');
});
test('multiple target gaps advance protection once and adverse gaps use observed prices and fees',()=>{
 const s=setup('SHORT',.0005);tick(s,s.c.targets[2]-.2);assert.equal(s.t.exitFills.length,3);assert.equal(s.t.exitGuard.label,'TP3');
 tick(s,s.c.targets[2]+1);assert.equal(s.t.remainingQuantity,0);assert.ok(s.t.exitFills.at(-1).price>s.c.targets[2]);assert.equal(s.t.exitFills.at(-1).label,'RETRACE_TP3');assert.equal(P.createModel(s.m.snapshot()).trades.length,1);
});
test('refresh recovery preserves the last attained TP and applies its trailing exit exactly once',()=>{
 const s=setup();tick(s,s.c.targets[0]);const q=s.t.remainingQuantity,anchor={...s.t.checkpoint};s.m.suspend('refresh',NOW+200);
 const loaded=P.createModel(s.m.snapshot()),rows=[anchor,{id:anchor.id+1,price:s.c.targets[0]-.1,at:anchor.at+1},{id:anchor.id+2,price:s.c.targets[0],at:anchor.at+2}];
 loaded.applyRecovery({symbol:s.c.symbol,anchor,head:rows.at(-1),rows,complete:true,headCheckedAt:NOW+300},NOW+300);const t=loaded.trades[0];assert.equal(t.remainingQuantity,0);assert.equal(t.exitFills.length,2);assert.equal(t.exitFills.at(-1).quantity,q);assert.equal(t.exitReason,'RETRACE_TP1');assert.equal(t.exitSource,'reconciled');
 loaded.tick(s.c.symbol,s.c.targets[0],NOW+400,{aggregateId:rows.at(-1).id});assert.equal(t.exitFills.length,2);assert.equal(P.createModel(loaded.snapshot()).trades.length,1);
});
test('profit protection releases original downside risk while preserving margin for remaining lots',()=>{
 const s=setup('SHORT',.0005),before=s.m.accountState(NOW+1);tick(s,s.c.targets[0]);const after=s.m.accountState(NOW+101);assert.ok(after.positionMargin<before.positionMargin);assert.equal(after.usedRisk,0);assert.ok(after.balance>before.balance);assert.equal(after.openCount,1);
});
test('tampered targets, protection and partial quantities are rejected across saved-ledger reloads',()=>{
 const s=setup();tick(s,s.c.targets[0]);for(const edit of [x=>x.exitGuard.price++,x=>x.exitGuard.bestPrice=x.exitGuard.price+1,x=>x.exitLegs[1].quantity++,x=>x.plannedTargets[0]++]){const saved=structuredClone(s.m.snapshot());edit(saved.trades[0]);assert.throws(()=>P.createModel(saved),/無效/);}
});
