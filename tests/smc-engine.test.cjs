const test=require('node:test'),assert=require('node:assert/strict'),E=require('../site/strategy-engine.js'),S=require('../site/smc-engine.js');
const {fixture,CT}=require('./smc-fixtures.cjs');
function analyze(f,count=37){return S.analyze(f.market,E.closedBars(f.higher,f.profile.high,f.confirmedAt),E.closedBars(f.lower.slice(0,count),f.profile.low,f.confirmedAt),f.confirmedAt,200,f.profile.id);}
test('both independent SMC profiles produce causal OB-midpoint plans with four targets',()=>{
 for(const id of ['4h15m','1h5m'])for(const direction of ['SHORT','LONG']){
  const f=fixture(id,direction),r=analyze(f),c=r.pending;
  assert.ok(c,JSON.stringify(r));assert.equal(c.direction,direction);assert.equal(c.profileId,id);assert.equal(c.timeframeLabel,f.profile.label);assert.equal(c.confirmedAt,f.confirmedAt);assert.equal(c.entryType,'LIMIT_OB');
  assert.equal(c.targets.length,4);assert.equal(c.entry,direction==='SHORT'?102.5:197.5);assert.equal(c.stopLoss,direction==='SHORT'?107.1:192.9);
  c.targets.forEach((v,i)=>assert.ok(Math.abs(v-c.entry)/Math.abs(c.entry-c.stopLoss)>=i+2-1e-12));assert.ok(c.highZone.createdAt<=c.touchAt);assert.ok(c.touchAt<=c.confirmedAt);
 }
});
test('mixed 1H/5M and 4H/15M inputs, stale data and future candles never manufacture a setup',()=>{
 const f=fixture();assert.throws(()=>S.analyze(f.market,E.closedBars(f.higher,'4h',f.confirmedAt),E.closedBars(f.lower.slice(0,37),'15m',f.confirmedAt),f.confirmedAt,200,'1h5m'),/時間框架|最新/);
 assert.throws(()=>S.analyze(f.market,E.closedBars(f.higher,'4h',f.confirmedAt),E.closedBars(f.lower.slice(0,36),'15m',f.confirmedAt-900000),f.confirmedAt,200,'4h15m'),/最新/);
 const old=analyze(f).pending,changed=structuredClone(f);changed.lower.at(-1)[4]=1;
 assert.deepEqual(analyze(changed).pending,old);
});
test('a wick through the protected low without a body close does not confirm CHoCH',()=>{
 const f=fixture();f.lower[36][4]=99;f.lower[36][1]=99.2;assert.equal(analyze(f).pending,null);
});
test('historical retests are not offered as fresh unfilled orders',()=>{
 const f=fixture(),now=f.confirmedAt+900000,r=S.analyze(f.market,E.closedBars(f.higher,'4h',now),E.closedBars(f.lower.slice(0,38),'15m',now),now,200,'4h15m');
 assert.equal(r.pending,null);assert.equal(r.status,'RETESTED');
});
test('position sizing uses 200 USDT and a 5% price-risk budget with lot constraints',()=>{
 const c=analyze(fixture()).pending,p=E.position(c,c.market);assert.equal(p.budget,10);assert.ok(p.risk<=10);assert.ok(p.ok);
 assert.equal(E.position(c,{...c.market,minQty:1e9}).ok,false);assert.equal(E.position(c,c.market,0).ok,false);
});
test('a protected low broken before pivot confirmation cannot be reused as an intact uptrend',()=>{
 const f=fixture();Object.assign(f.lower[32],{1:97,2:102.2,3:95,4:95.5});
 assert.equal(analyze(f).pending,null);
});
