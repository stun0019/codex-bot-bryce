const test=require('node:test'),assert=require('node:assert/strict');
const M=require('../site/macd-engine.js'),D=require('../site/strategy-data.js'),P=require('../site/paper-engine.js');
const fixture=require('./fixtures/smc-series.json'),F=require('./fixtures/dual-watch.cjs');

test('six price positions use only SMA83 versus EMA200 for direction',()=>{
 const cases=[['UP',1600,'LONG',m=>m.close>m.sma83&&m.sma83>m.ema200],['UP',1430,'LONG',m=>m.sma83>m.close&&m.close>m.ema200],['UP',1200,'LONG',m=>m.sma83>m.ema200&&m.ema200>m.close],['DOWN',1400,'SHORT',m=>m.close<m.sma83&&m.sma83<m.ema200],['DOWN',1570,'SHORT',m=>m.sma83<m.close&&m.close<m.ema200],['DOWN',1800,'SHORT',m=>m.sma83<m.ema200&&m.ema200<m.close]];
 for(const [direction,last,expected,position]of cases){const high=F.bars('4h',{direction,last}),m=M.trend(high);assert.ok(position(m),JSON.stringify(m));assert.equal(m.direction,expected);const r=M.analyze({},high,F.bars('15m',{direction:'FLAT'}),F.asOf);assert.equal(r.direction,expected);assert.equal(r.pending,null);assert.equal(r.candidate,null);}
});

test('SMA and EMA agree with independent arithmetic and exponential weights',()=>{
 const b=F.bars('4h'),m=M.trend(b),closes=b.map(x=>x.close),alpha=2/201,n=closes.length-200;
 const seed=closes.slice(0,200).reduce((s,x)=>s+x,0)/200;
 const ema=seed*(1-alpha)**n+closes.slice(200).reduce((s,x,i)=>s+alpha*x*(1-alpha)**(n-1-i),0);
 assert.equal(m.sma83,closes.slice(-83).reduce((s,x)=>s+x,0)/83);assert.ok(Math.abs(m.ema200-ema)<1e-9);
 assert.equal(M.trend(b.slice(-199)),null);assert.equal(M.trend(F.bars('4h',{direction:'FLAT'})).direction,null);
 const insufficient=M.analyze({},F.bars('4h',{count:199}),F.bars('15m'),F.asOf);assert.equal(insufficient.direction,null);assert.equal(insufficient.status,'INSUFFICIENT');
});

test('two timeframe pairs are independent and lower direction cannot veto a watch',()=>{
 for(const [id,high,low,direction]of [['4h15m','4h','15m','UP'],['1h5m','1h','5m','DOWN']]){
  const higher=F.bars(high,{direction}),lower=F.bars(low,{direction:direction==='UP'?'DOWN':'UP'}),r=M.analyze({},higher,lower,F.asOf,200,id);
  assert.equal(r.direction,direction==='UP'?'LONG':'SHORT');assert.equal(r.status,'WATCH');assert.equal(r.pending,null);assert.equal(r.candidate,null);assert.equal(r.trend.at,higher.at(-1).closeTime+1);assert.ok(r.confirmedAt<=F.asOf);
 }
 assert.equal(Object.keys(M.PROFILES).length,2);assert.equal(M.MODE,'CANDIDATES_ONLY');
 assert.throws(()=>M.analyze({},F.bars('4h'),F.bars('15m'),F.asOf,200,'1h5m'),/最新已收盤|不連續/);
});

test('latest levels match independent left2/right2 swing calculation',()=>{
 for(const id of Object.keys(M.PROFILES)){
  const p=M.PROFILES[id],higher=F.bars(p.high),lower=F.bars(p.low,{direction:'FLAT'}),r=M.analyze({},higher,lower,F.asOf,200,id);
  let high=null,low=null;
  for(let i=2;i<lower.length-2;i++){const b=lower[i],n=[lower[i-2],lower[i-1],lower[i+1],lower[i+2]];if(n.every(x=>x.high<b.high))high=b;if(n.every(x=>x.low>b.low))low=b;}
  assert.equal(r.recentHigh.openTime,high.openTime);assert.equal(r.recentHigh.price,high.high);assert.equal(r.recentLow.openTime,low.openTime);assert.equal(r.recentLow.price,low.low);assert.equal(r.recentHigh.confirmedAt,r.recentHigh.openTime+3*F.durations[p.low]);
 }
});

test('unconfirmed extremes, stale bars and gaps never produce spurious levels',()=>{
 const f=fixture,low=JSON.parse(JSON.stringify(f.lower)),base=M.analyze(f.market,f.higher,low,f.asOf);low.at(-1).high=1e9;
 assert.deepEqual(M.analyze(f.market,f.higher,low,f.asOf).recentHigh,base.recentHigh);
 assert.throws(()=>M.analyze(f.market,f.higher,f.lower.slice(0,-1),f.asOf),/最新已收盤/);
 const gap=f.lower.filter((_,i)=>i!==100);assert.throws(()=>M.analyze(f.market,f.higher,gap,f.asOf),/不連續/);
 const a=M.createAnalyzer();for(const b of f.higher)a.pushHigh(b);assert.throws(()=>a.pushLow(f.lower[0]),/晚於/);
});

test('new automatic entries are blocked and existing pending entries cancelled even on a quote',()=>{
 const c=JSON.parse(JSON.stringify(require('./fixtures/smc-candidate.json'))),p=P.createModel();p.enableAccount(200,c.confirmedAt);assert.equal(p.addCandidates([c],200,c.confirmedAt),0);
 const prior=M.MODE;try{M.MODE='SMC_ENTRY';assert.equal(p.addCandidates([c],200,c.confirmedAt),1);}finally{M.MODE=prior;}
 p.tick(c.symbol,c.entry,c.confirmedAt+1000,{aggregateId:1});assert.equal(p.trades[0].status,'SKIPPED');assert.equal(p.stats('macd').open,0);assert.equal(p.trades[0].entry,undefined);
});

test('combined Top20 scans forty independent pair observations and caches each closed interval',async()=>{
 const names=Array.from({length:24},(_,i)=>'C'+i+'USDT'),calls=[];
 const base={quoteAsset:'USDT',status:'TRADING',filters:[{filterType:'PRICE_FILTER',tickSize:'.1'},{filterType:'LOT_SIZE',stepSize:'.001',minQty:'.001',maxQty:'1000'}]};
 const info={symbols:names.map((symbol,i)=>({...base,symbol,contractType:i%2?'TRADIFI_PERPETUAL':'PERPETUAL'}))};
 const client=D.createClient({intervalMs:0,clock:()=>F.asOf,fetcher:async url=>{
  const u=new URL(url);let data;
  if(u.pathname.endsWith('exchangeInfo'))data=info;
  else if(u.pathname.endsWith('/time'))data={serverTime:F.asOf};
  else if(u.pathname.endsWith('/ticker/24hr'))data=names.map((symbol,i)=>({symbol,quoteVolume:String(100+i)}));
  else{const interval=u.searchParams.get('interval');calls.push(u.searchParams.get('symbol')+':'+interval);data=F.rows(F.bars(interval,{direction:interval==='1h'?'DOWN':interval==='4h'?'UP':'FLAT'}));}
  return{ok:true,status:200,json:async()=>data};
 }});
 for(let i=0;i<2;i++){
  const r=await client.scan();assert.equal(r.total,40);assert.equal(r.completed,40);assert.equal(r.trending,40);assert.equal(r.errors,0);assert.equal(r.candidates.length,0);assert.equal(r.rankedMarkets.filter(m=>m.contractType==='TRADIFI_PERPETUAL').length,10);assert.equal(r.symbols.length,20);
  assert.ok(r.observations.every(o=>o.direction===(o.profileId==='4h15m'?'LONG':'SHORT')&&o.recentHigh&&o.recentLow));assert.equal(r.filters.higherDirection,'SMA83_VS_EMA200');
 }
 assert.equal(calls.length,80);assert.equal(new Set(calls).size,80);assert.ok(!calls.some(c=>/^C[0-3]USDT:/.test(c)));
});
