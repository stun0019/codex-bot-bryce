const test=require('node:test'),assert=require('node:assert/strict'),E=require('../site/strategy-engine.js');
const {rows,NOW}=require('./strategy-fixtures.cjs');
test('only supported SMC intervals are parsed and malformed/gapped/stale candles fail closed',()=>{
 for(const interval of ['4h','1h','15m','5m']){const data=rows(interval);assert.equal(E.closedBars(data,interval,NOW).length,80);const gap=[...data];gap.splice(5,1);assert.throws(()=>E.closedBars(gap,interval,NOW),/gap/);}
 assert.throws(()=>E.closedBars(rows('15m'),'1m',NOW),/Unsupported/);assert.throws(()=>E.closedBars(rows('15m').slice(0,-1),'15m',NOW),/stale/);
});
test('MA strategy entry logic is removed; utility rounding, lot limits and four targets remain',()=>{
 assert.equal(E.evaluate,undefined);assert.equal(E.trend,undefined);const c={entry:100,stopLoss:98,target:104},m={stepSize:.001,minQty:.001,maxQty:100,minNotional:5};
 assert.equal(E.SETTINGS.capital,200);assert.equal(E.SETTINGS.riskFraction,.05);assert.equal(E.targets(100,98,'LONG',.01).length,4);
 assert.ok(E.position(c,m).risk<=10);assert.equal(E.position(c,{...m,minNotional:100000}).ok,false);assert.equal(E.position(c,m,0).ok,false);
});
