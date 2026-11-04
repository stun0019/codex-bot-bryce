const test=require('node:test'),assert=require('node:assert/strict'),EMA=require('../site/ema-engine.js'),E=require('../site/strategy-engine.js');
const {fixture,analyze}=require('./ema-fixtures.cjs');
test('each independent timeframe uses strict EMA20/60/200 alignment and a closed lower-TF EMA20 touch',()=>{
 for(const id of ['4h15m','1h5m'])for(const direction of ['LONG','SHORT']){const f=fixture(id,direction),r=analyze(f),c=r.candidate;assert.ok(c,JSON.stringify(r));assert.equal(c.direction,direction);assert.equal(c.profileId,id);assert.equal(c.strategyVersion,EMA.VERSION);assert.equal(c.entryType,'LIMIT_CONFIRM');assert.equal(c.confirmedAt,f.asOf);assert.equal(c.expiresAt,f.asOf+E.INTERVALS[f.profile.low]);
  assert.equal(c.entry,f.lower.at(-1)[4]);assert.equal(c.stopLoss,Number((direction==='LONG'?f.lower.at(-1)[3]-.01:f.lower.at(-1)[2]+.01).toFixed(2)));assert.equal(c.targets.length,4);assert.ok(!c.highZone);assert.ok(!c.macd);
 }
});
test('neutral, mixed and insufficient high-timeframe EMA alignment cannot produce entries',()=>{
 const f=fixture();for(const row of f.higher){row[1]=100;row[2]=101;row[3]=99;row[4]=100;}assert.equal(analyze(f).status,'NO_TREND');assert.equal(analyze(f).candidate,null);f.higher=f.higher.slice(-199);assert.equal(analyze(f).status,'WARMUP');
 const bars=Array.from({length:300},()=>({close:100,closeTime:1}));assert.equal(EMA.trend(bars).direction,null);assert.equal(EMA.ema(bars.slice(0,19),20),null);
});
test('a trend without a lower EMA20 touch or a close on the trend side is not an entry',()=>{
 const f=fixture(),current=f.lower.at(-1);current[1]=current[4];current[3]=current[4]-.05;assert.equal(analyze(f).candidate,null);
 const g=fixture();g.lower.at(-1)[4]-=2;g.lower.at(-1)[3]-=1;assert.equal(analyze(g).candidate,null);
});
test('a touch followed by a next-candle close back includes both candles in the stop extreme',()=>{
 const f=fixture(),before=f.lower.at(-2),last=f.lower.at(-1);before[1]=before[4];before[4]-=2;before[3]=before[4]-.5;before[2]+=1;last[3]=last[4]-1.5;
 const c=analyze(f).candidate;assert.ok(c);assert.equal(c.pullback.touchAt,before[0]);assert.equal(c.stopLoss,Number((Math.min(before[3],last[3])-.01).toFixed(2)));
});
test('unfinished candles never participate, mixed intervals and stale bars fail closed',()=>{
 const f=fixture(),c=analyze(f).candidate,next=structuredClone(f.lower.at(-1)),duration=E.INTERVALS[f.profile.low];next[0]+=duration;next[6]+=duration;next[4]*=2;next[2]=next[4]+1;f.lower.push(next);assert.deepEqual(analyze(f).candidate,c);
 assert.throws(()=>EMA.analyze(f.market,E.closedBars(f.higher,f.profile.high,f.asOf),E.closedBars(f.lower,f.profile.low,f.asOf),f.asOf,200,'1h5m'),/已收盤|框架/);
 f.lower=f.lower.slice(0,-2);assert.throws(()=>analyze(f),/stale/);
});
test('optional RSI/volume gate is independent and never adds the removed SMC or MACD criteria',()=>{
 const f=fixture();assert.ok(analyze(f).candidate);assert.equal(analyze(f,{rsiFilter:true}).status,'FILTERED');
 const low=Array.from({length:40},(_,i)=>({close:100-i,volume:i===39?300:100,closeTime:i}));assert.equal(EMA.entryFilter(low,'LONG').matches,true);assert.equal(EMA.entryFilter(low,'SHORT').matches,false);
});
