const test=require('node:test'),assert=require('node:assert/strict'),F=require('../site/fib-engine.js'),E=require('../site/strategy-engine.js');
const{fixture,analyze,candidate}=require('./fib-fixtures.cjs');
test('Fib prices reproduce the supplied chart and 0.5 never becomes entry',()=>{
 const p=F.prices({a:{price:.17759},b:{price:.16719}},'SHORT',.00001);assert.equal(p.entry,.17463);assert.equal(p.stopLoss,.17760);assert.deepEqual(p.targets,[.16719,.16438,.16076,.15679]);assert.ok(p.rewardRisks[0]>2);
});
test('both independent pairs require an existing zone, closed BOS and post-break confirmed extreme before placing 0.715',()=>{
 for(const id of ['4h15m','1h5m'])for(const direction of ['LONG','SHORT']){
  const f=fixture(id,direction);assert.equal(analyze(f,391).status,'WAIT_ZONE');assert.equal(analyze(f,392).status,'WAIT_BREAK');assert.equal(analyze(f,395).pending,null);assert.equal(analyze(f,396).status,'WAIT_EXTREME');assert.equal(analyze(f,398).pending,null);
  const c=analyze(f,399).pending;assert.ok(c);assert.equal(c.direction,direction);assert.equal(c.entryType,'LIMIT_FIB');assert.equal(c.targetMode,'FIB');assert.deepEqual(c.exitFractions,[.2,.3,.3,.2]);assert.ok(F.valid(c));assert.equal(c.fib.a.openTime,f.lower[392][0]);assert.equal(c.fib.b.openTime,f.lower[396][0]);assert.equal(c.fib.structure.breakBar.openTime,f.lower[395][0]);assert.equal(c.fib.zoneTouch.openTime,f.lower[391][0]);assert.ok(c.fib.highZone.createdAt<=c.fib.zoneTouch.openTime);assert.notEqual(c.entry,f.lower[398][4]);assert.deepEqual(analyze(f).pending,c);
 }
});
test('a wick through the prior level is not a close break and touching a fresh unconfirmed zone cannot arm',()=>{
 const wick=fixture();wick.lower[395][4]=104;assert.equal(analyze(wick,396).status,'WAIT_BREAK');
 const noZone=fixture();noZone.higher[396][2]=109.3;assert.equal(analyze(noZone).pending,null);
});
test('a historical 0.715 touch consumes the pending wave and is never offered as a new entry',()=>{
 const f=fixture(),d=E.INTERVALS[f.profile.low],at=f.asOf;f.lower.push([at,105,107.3,104,107,100,at+d-1]);assert.equal(analyze(f).pending,null);assert.equal(analyze(f).status,'MISSED');
 const early=fixture();early.lower[397][2]=108;assert.equal(analyze(early).pending,null);
});
test('source bars, zone boundaries, BOS close, times and frozen Fib targets are validated on reload',()=>{
 const c=candidate();assert.ok(F.valid(c));for(const edit of [x=>x.fib.a.price++,x=>x.targets[0]++,x=>x.entry++,x=>x.confirmedAt++,x=>x.exitFractions[0]=.3,x=>x.fib.highZone.low--,x=>x.fib.b.bar.low--,x=>x.fib.structure.pivot.price++,x=>x.fib.structure.breakBar.close=104,x=>x.fib.entryLevel=.5]){const bad=structuredClone(c);edit(bad);assert.equal(F.valid(bad),false);}
});
test('fees, neutral EMA, optional RSI gating and unfinished future candles cannot manufacture eligible entries',()=>{
 const f=fixture();assert.equal(analyze(f,400,{rsiFilter:true}).pending,null);const c=analyze(f).pending;assert.equal(E.position(c,c.market,200,{feeRate:.01}).ok,false);
 const future=structuredClone(f.lower.at(-1)),d=E.INTERVALS[f.profile.low];future[0]+=d;future[6]+=d;future[2]+=20;f.lower.push(future);assert.deepEqual(analyze(f,400).pending,c);
 const flat=fixture();for(const r of flat.higher){r[1]=100;r[2]=101;r[3]=99;r[4]=100;}assert.equal(analyze(flat).pending,null);
});
