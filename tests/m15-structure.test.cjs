const test=require('node:test'),assert=require('node:assert/strict'),M=require('../site/macd-engine.js'),fixture=require('./fixtures/smc-series.json');
const points=a=>a.map((price,i)=>({price,openTime:i*900000,confirmedAt:(i+3)*900000}));
test('M15 HH/HL, LH/LL, mixed, equal and missing structures are explicit',()=>{
 assert.equal(M.structure(points([100,110]),points([90,95]),'LONG').state,'RISING');assert.equal(M.structure(points([100,110]),points([90,95]),'LONG').aligned,true);
 assert.equal(M.structure(points([110,100]),points([95,90]),'SHORT').state,'FALLING');assert.equal(M.structure(points([110,100]),points([95,90]),'LONG').aligned,false);
 assert.equal(M.structure(points([100,110]),points([95,90]),'LONG').state,'MIXED');assert.equal(M.structure(points([100,100]),points([90,95]),'LONG').highChange,'EQ');assert.equal(M.structure(points([100,100]),points([90,95]),'LONG').state,'MIXED');
 assert.equal(M.structure(points([100]),points([90,95]),'LONG').state,'INSUFFICIENT');assert.equal(M.structure([],[],'SHORT').aligned,null);
});
test('structure is derived from the latest two confirmed swing pairs, independently of the higher-timeframe direction',()=>{
 const f=fixture,r=M.analyze(f.market,f.higher,f.lower,f.asOf),high=[],low=[];for(let i=2;i<f.lower.length-2;i++){const b=f.lower[i],n=[f.lower[i-2],f.lower[i-1],f.lower[i+1],f.lower[i+2]];if(n.every(x=>x.high<b.high))high.push({price:b.high,openTime:b.openTime});if(n.every(x=>x.low>b.low))low.push({price:b.low,openTime:b.openTime});}
 assert.equal(r.structure.previousHigh.openTime,high.at(-2).openTime);assert.equal(r.structure.previousLow.openTime,low.at(-2).openTime);assert.equal(r.structure.state,M.structure(high,low,r.direction).state);assert.equal(r.pending,null);assert.equal(r.candidate,null);
});
