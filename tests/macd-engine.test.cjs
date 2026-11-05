const test=require('node:test'),assert=require('node:assert/strict'),B=require('../site/macd-engine.js'),P=require('../site/paper-engine.js'),R=require('../site/candidate-records.js');
const{fixture,analyze,NOW}=require('./macd-fixtures.cjs');
test('4H/15M MACD agreement + pullback structure break produces both mirror directions',()=>{
 for(const direction of ['LONG','SHORT']){const r=analyze(fixture(direction)),c=r.pending;assert.ok(c,JSON.stringify(r));assert.equal(c.direction,direction);assert.ok(B.valid(c));assert.equal(c.profileId,'4h15m');assert.equal(c.confirmedAt,NOW);assert.equal(c.expiresAt,NOW+900000);assert.equal(c.targets.length,4);assert.equal(c.fib.impulse.price,direction==='LONG'?180:120);assert.ok(R.valid(c));}
});
test('no close beyond the small structure means no entry',()=>{const f=fixture();f.lower.at(-1)[4]=149.5;assert.equal(analyze(f).pending,null);});
test('future candles and unclosed bars cannot create an earlier signal',()=>{
 const f=fixture();f.asOf-=900000;assert.equal(analyze(f).pending,null);
 const a=fixture(),b=fixture();b.lower.push([NOW,150,170,130,165,900,NOW+299999]);assert.deepEqual(analyze(a),analyze(b));
});
test('new target plan rejects tampering and freezes prices after opening/reload',()=>{
 const c=analyze(fixture()).pending;
 for(const modify of [x=>x.stopLoss-=1,x=>x.targets[0]+=1,x=>x.fib.trigger.price+=1,x=>x.fib.highMacd.dif=-1,x=>x.fib.lowPoint.confirmedAt=NOW+1]){const x=structuredClone(c);modify(x);assert.equal(B.valid(x),false);}
 const m=P.createModel();m.enableAccount(200,NOW);assert.equal(m.addCandidates([c],200,NOW),1);m.tick(c.symbol,c.entry,NOW+1,{aggregateId:100});assert.equal(m.trades[0].status,'OPEN');assert.equal(m.trades[0].exitLegs.length,4);
 const restored=P.createModel(m.snapshot());assert.equal(restored.trades[0].status,'OPEN');assert.deepEqual(restored.trades[0].plannedTargets,c.targets);
 restored.tick(c.symbol,c.targets[0],NOW+2,{aggregateId:101});assert.equal(restored.trades[0].exitFills.length,1);restored.tick(c.symbol,c.targets[0]+.1,NOW+3,{aggregateId:102});restored.tick(c.symbol,c.targets[0],NOW+4,{aggregateId:103});assert.equal(restored.trades[0].exitReason,'RETRACE_TP1');assert.equal(restored.trades[0].remainingQuantity,0);assert.doesNotThrow(()=>P.createModel(restored.snapshot()));
});
test('shared 5% risk caps the new signals and does not merge old strategy stats',()=>{
 const c=analyze(fixture()).pending,d=structuredClone(c);d.symbol=d.market.symbol='ETHUSDT';const m=P.createModel();m.enableAccount(200,NOW);assert.equal(m.addCandidates([c,d],200,NOW),1);assert.ok(m.accountState(NOW).usedRisk<=10+1e-8);assert.equal(m.stats('4h15m').waiting,1);
});
