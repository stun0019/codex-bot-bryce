const test=require('node:test'),assert=require('node:assert/strict');
const E=require('../site/strategy-engine.js'),S=require('../site/smc-engine.js'),P=require('../site/paper-engine.js'),B=require('../site/bt-engine.js');
const {fixture}=require('./smc-fixtures.cjs');
function analyze(f,options={}){return S.analyze(f.market,E.closedBars(f.higher,f.profile.high,f.confirmedAt),E.closedBars(f.lower.slice(0,37),f.profile.low,f.confirmedAt),f.confirmedAt,200,f.profile.id,options);}
test('closed high-timeframe DIF gates direction independently for both profiles and both sides',()=>{
 for(const id of ['4h15m','1h5m'])for(const direction of ['LONG','SHORT']){
  const f=fixture(id,direction),c=analyze(f).pending;assert.equal(c.direction,direction);assert.equal(c.macd.direction,direction);
  // An earlier trending context reverses DIF while leaving the OB and CHoCH price pattern intact.
  for(let i=0;i<100;i++){const price=20+i*.8,value=direction==='SHORT'?price:300-price;f.higher[i][1]=value;f.higher[i][2]=value+.2;f.higher[i][3]=value-.2;f.higher[i][4]=value;}
  assert.equal(analyze(f).pending,null);assert.equal(analyze(f,{macdFilter:false}).pending.direction,direction);
 }
});
test('MACD warmup and zero DIF are neutral; DIF rather than histogram decides direction',()=>{
 const bars=Array.from({length:100},(_,i)=>({close:100,closeTime:i}));assert.equal(S.macd(bars.slice(0,99)),null);assert.equal(S.macd(bars).direction,null);
 const rebound=Array.from({length:100},(_,i)=>({close:i<95?200-i:106+(i-95),closeTime:i})),m=S.macd(rebound);
 assert.ok(m.dif<0);assert.ok(m.histogram>0);assert.equal(m.direction,'SHORT');
 const f=fixture();f.higher=f.higher.slice(-22);assert.equal(analyze(f).status,'WAIT_BIAS');assert.equal(analyze(f).pending,null);
});
test('RSI uses strict directional thresholds and +200% means at least three times previous base volume',()=>{
 const make=(direction,volume=300)=>Array.from({length:30},(_,i)=>({close:direction==='LONG'?100-i:100+i,volume:i===29?volume:100,closeTime:i}));
 assert.equal(S.entryFilter(make('LONG'),'LONG').matches,true);assert.equal(S.entryFilter(make('LONG'),'SHORT').matches,false);
 assert.equal(S.entryFilter(make('SHORT'),'SHORT').matches,true);assert.equal(S.entryFilter(make('SHORT'),'LONG').matches,false);
 assert.equal(S.entryFilter(make('LONG',299.99),'LONG').matches,false);
 const rows=make('LONG');rows.at(-2).volume=0;assert.equal(S.entryFilter(rows,'LONG').matches,false);rows.at(-2).volume=100;delete rows.at(-1).volume;assert.equal(S.entryFilter(rows,'LONG').matches,false);
 function boundary(positive,negative){let c=200;return [{close:c,volume:100,closeTime:0},...Array.from({length:14},(_,i)=>({close:(c+=i<7?positive:-negative),volume:i===13?300:100,closeTime:i+1}))];}
 assert.equal(S.entryFilter(boundary(3,7),'LONG').rsi,30);assert.equal(S.entryFilter(boundary(3,7),'LONG').matches,false);
 assert.equal(S.entryFilter(boundary(7,3),'SHORT').rsi,70);assert.equal(S.entryFilter(boundary(7,3),'SHORT').matches,false);
});
test('optional filter changes candidate inclusion on the latest closed low-timeframe bar without changing core setup',()=>{
 for(const id of ['4h15m','1h5m']){
  const f=fixture(id,'SHORT'),off=analyze(f),on=analyze(f,{rsiFilter:true});assert.ok(off.pending);assert.equal(on.pending,null);assert.equal(on.status,'FILTERED');
  // Build a bullish lower-TF RSI context before the unchanged final price structure.
  const lo=E.INTERVALS[f.profile.low],prefix=Array.from({length:200},(_,i)=>{const close=1+i*.38,at=f.lower[0][0]-(200-i)*lo;return [at,close,close+.1,Math.max(.01,close-.1),close,100,at+lo-1];});
  f.lower.unshift(...prefix);f.lower[236][5]=300;
  const result=S.analyze(f.market,E.closedBars(f.higher,f.profile.high,f.confirmedAt),E.closedBars(f.lower.slice(0,237),f.profile.low,f.confirmedAt),f.confirmedAt,200,id,{rsiFilter:true});
  // The actual RSI may remain below70 after CHoCH; filtering cannot substitute an older oversold/overbought candle.
  assert.equal(result.entryFilter.at,f.confirmedAt);assert.equal(result.entryFilter.volumeRatio,3);
  assert.equal(!!result.pending,result.entryFilter.rsi>70);
 }
});
test('v1 SMC paper records remain readable after the MACD strategy version changes',()=>{
 const c=analyze(fixture(),{macdFilter:false}).pending,m=P.createModel();m.addCandidates([c],200,c.confirmedAt);
 assert.equal(m.trades[0].strategyVersion,S.LEGACY_VERSION);assert.equal(P.createModel(m.snapshot()).trades.length,1);
});
test('historical optional filtering preserves volume and reduces ineligible entries without manufacturing fills',()=>{
 const f=fixture(),base=B.run(f.input),filtered=B.run({...f.input,config:{...f.input.config,rsiFilter:true}});
 assert.ok(base.stats.closed>0);assert.equal(filtered.stats.closed,0);assert.ok(filtered.assumptions.some(s=>s.includes('RSI14')));
 assert.equal(B.parse(f.lower,f.profile.low).at(-1).volume,100);const bad=structuredClone(f.lower);bad[0][5]=-1;assert.throws(()=>B.parse(bad,f.profile.low),/格式/);
});
test('shared position calculator rejects nonfinite targets, invalid direction and malformed exchange limits',()=>{
 const c=analyze(fixture()).pending;for(const change of [{target:NaN},{target:Infinity},{direction:'INVALID'},{targets:[Infinity,80,70]}])assert.equal(E.position({...c,...change},c.market).ok,false);
 for(const change of [{maxQty:0},{minQty:NaN},{minNotional:NaN}])assert.equal(E.position(c,{...c.market,...change}).ok,false);
});
