const assert=require('node:assert/strict');
const test=require('node:test');
const E=require('../site/strategy-engine.js');
const {NOW,rows,market}=require('./strategy-fixtures.cjs');
function bars(interval,direction='LONG'){return E.closedBars(rows(interval,direction),interval,NOW);}
function candidate(direction='LONG'){return E.evaluate(market(),bars('4h',direction),bars('15m',direction),NOW);}

test('4H MA20 slope and price must agree; neutral or conflicting conditions do not signal',()=>{
  assert.equal(E.trend(bars('4h')),'LONG');assert.equal(E.trend(bars('4h','SHORT')),'SHORT');assert.equal(E.trend(bars('4h','FLAT')),null);
  const conflict=bars('4h');Object.assign(conflict.at(-1),{close:112,open:112,high:113,low:111});
  assert.equal(E.trend(conflict),null);
});
test('only strictly independent 4H trend and 15M entry series are accepted',()=>{
  assert.throws(()=>E.closedBars(rows('15m'),'5m',NOW),/Unsupported/);
  assert.throws(()=>E.closedBars(rows('4h'),'1h',NOW),/Unsupported/);
  assert.throws(()=>E.trend(bars('15m')),/4H/);
  assert.throws(()=>E.evaluate(market(),bars('4h'),bars('4h'),NOW),/15M/);
});
test('uses SMA, discards open candles and rejects gaps, duplicates and stale history',()=>{
  const data=rows('15m'),duration=E.INTERVALS['15m'],start=Math.floor(NOW/duration)*duration;
  data.push([start,1,99999,.01,99999,1,start+duration-1]);
  assert.equal(E.closedBars(data,'15m',NOW).length,80);
  assert.equal(E.ma([{close:1},{close:2},{close:9}],3),4);
  const missing=rows('15m');missing.splice(10,1);assert.throws(()=>E.closedBars(missing,'15m',NOW),/gap/);
  const duplicate=rows('15m');duplicate.splice(10,0,duplicate[10]);assert.throws(()=>E.closedBars(duplicate,'15m',NOW),/duplicate/);
  assert.throws(()=>E.closedBars(rows('15m').slice(0,-1),'15m',NOW),/stale/);
  assert.throws(()=>E.evaluate(market(),bars('4h'),bars('15m'),NOW+E.INTERVALS['15m']),/latest/);
});
test('long and short require a MA5 reclaim plus an actual MA10/20 retest',()=>{
  assert.equal(candidate().direction,'LONG');assert.equal(candidate('SHORT').direction,'SHORT');
  const noCross=bars('15m');noCross.at(-2).close=101;
  assert.equal(E.evaluate(market(),bars('4h'),noCross,NOW),null);
  const noTouch=bars('15m');Object.assign(noTouch.at(-2),{high:96,low:94,close:95});Object.assign(noTouch.at(-1),{low:101,high:103,close:102});
  assert.equal(E.evaluate(market(),bars('4h'),noTouch,NOW),null);
});
test('volume and structural swing heuristics are not mixed into price/MA signals',()=>{
  const four=rows('4h'),fifteen=rows('15m');four.forEach(row=>row[5]=0);fifteen.forEach(row=>row[5]=0);
  const result=E.evaluate(market(),E.closedBars(four,'4h',NOW),E.closedBars(fifteen,'15m',NOW),NOW);
  assert.equal(result.entry,candidate().entry);assert.equal(result.stopLoss,candidate().stopLoss);
});
test('stops are one tick outside retest and confirmation extremes; target is at least 2R',()=>{
  const long=candidate(),short=candidate('SHORT');
  assert.equal(long.entry,101);assert.equal(long.stopLoss,93.9);
  assert.equal(short.entry,199);assert.equal(short.stopLoss,206.1);
  for(const result of [long,short]){assert.ok(Math.abs(result.target-result.entry)/Math.abs(result.entry-result.stopLoss)>=2);assert.equal(result.expiresAt,Math.floor(NOW/900000)*900000+900000);}
});
test('70 USDT gives a 2.10 USDT maximum price-risk budget after quantity rounding',()=>{
  for(const direction of ['LONG','SHORT']){const result=candidate(direction),plan=result.plan;assert.equal(plan.ok,true);assert.equal(plan.budget,2.1);assert.ok(plan.risk<=2.1);assert.ok(plan.profit>=plan.risk*2);assert.ok(plan.quantity>0);}
  const next=E.position(candidate(),market(),140);assert.equal(next.budget,4.2);assert.ok(next.risk<=4.2);
});
test('lot size, minimum notional, maximum quantity and invalid capital are respected',()=>{
  const c=candidate();assert.equal(E.position(c,{...market(),minQty:100}).ok,false);
  assert.equal(E.position(c,{...market(),minNotional:100000}).ok,false);
  assert.equal(E.position(c,market(),0).ok,false);
  const capped=E.position(c,{...market(),maxQty:.1});assert.equal(capped.quantity,.1);
});
test('small tick sizes still keep risk within budget and reward at least twice risk',()=>{
  for(const entry of [.00001,.001,1,1000])for(const ratio of [.001,.01,.1]){
    const c={entry,stopLoss:entry*(1-ratio),target:entry*(1+2*ratio)};
    const plan=E.position(c,{stepSize:.000001,minQty:.000001,maxQty:1e15,minNotional:0});
    assert.ok(plan.ok);assert.ok(plan.risk<=2.1);
  }
});
