const test = require('node:test'), assert = require('node:assert/strict');
const R = require('../site/rsi-volume.js');
const STEP = 900000, NOW = 1800000000000; // aligned 15M boundary
function rows({ closes = Array.from({length:40},(_,i)=>100-i), ratio = 3, previous = 10 } = {}) {
  return closes.map((close,i)=>[NOW-(closes.length-i)*STEP,String(close),String(close+1),String(close-1),String(close),String(i===closes.length-1?previous*ratio:previous),NOW-(closes.length-i-1)*STEP-1]);
}
const info = symbols => ({symbols:symbols.map(symbol=>({symbol,status:'TRADING',quoteAsset:'USDT',contractType:'PERPETUAL'}))});
function setup({symbols=['BTCUSDT','ETHUSDT'], fetch:custom}={}) {
  const calls=[]; let now=NOW;
  const client=R.createClient({intervalMs:0,concurrency:2,clock:()=>now,fetcher:async(url,opts)=>{
    const u=new URL(url); calls.push(u); if(custom)return custom(u,opts);
    return {ok:true,status:200,json:async()=>u.pathname.endsWith('/time')?{serverTime:now}:u.pathname.endsWith('exchangeInfo')?info(symbols):rows().map(row=>[row[0]+now-NOW,...row.slice(1,6),row[6]+now-NOW])};
  }});
  return {client,calls,setNow(value){now=value;}};
}
test('Wilder RSI agrees with a published hand-calculated seed and smooths later changes',()=>{
  const prices=[44.34,44.09,44.15,43.61,44.33,44.83,45.10,45.42,45.84,46.08,45.89,46.03,45.61,46.28,46.28];
  assert.ok(Math.abs(R.rsi(prices)-70.4641350211)<1e-8);
  assert.ok(Math.abs(R.rsi([...prices,46])-66.2496185536)<1e-8);
  assert.equal(R.rsi(Array(15).fill(100)),50); assert.equal(R.rsi(Array.from({length:15},(_,i)=>i+1)),100);
  assert.equal(R.rsi(Array.from({length:15},(_,i)=>30-i)),0);
});
test('RSI <30 and volume growth >=200% must occur on the same latest closed bar',()=>{
  assert.equal(R.evaluate('BTCUSDT',rows(),NOW).matches,true);
  assert.equal(R.evaluate('BTCUSDT',rows({ratio:2.999}),NOW).matches,false);
  assert.equal(R.evaluate('BTCUSDT',rows({ratio:2}),NOW).matches,false);
  const rising=Array.from({length:40},(_,i)=>100+i); assert.equal(R.evaluate('BTCUSDT',rows({closes:rising}),NOW).matches,false);
  const exactly30=[100,103,96,...Array(12).fill(96)]; assert.ok(R.rsi(exactly30)>=30);assert.equal(R.evaluate('BTCUSDT',rows({closes:exactly30}),NOW).matches,false);
  const r=R.evaluate('BTCUSDT',rows(),NOW);assert.equal(r.volumeGrowth,200);assert.equal(r.confirmedAt,NOW);
});
test('unfinished bars cannot create matches and stale/gapped/malformed data is rejected',()=>{
  const base=rows({ratio:2}),open=[NOW,'1','100','1','1','99999',NOW+STEP-1];assert.equal(R.evaluate('BTCUSDT',[...base,open],NOW+100).matches,false);
  assert.throws(()=>R.evaluate('BTCUSDT',base.slice(0,-1),NOW),/stale/);
  assert.throws(()=>R.evaluate('BTCUSDT',base.filter((_,i)=>i!==10),NOW),/gap/);
  const invalid=rows();invalid.at(-1)[5]='NaN';assert.throws(()=>R.evaluate('BTCUSDT',invalid,NOW),/成交量/);
  assert.throws(()=>R.evaluate('BTCUSDT',rows().slice(-10),NOW),/不足/);
  assert.equal(R.evaluate('BTCUSDT',rows({previous:0}),NOW).matches,false);
});
test('all active USDT perpetuals are scanned beyond Top20, using only fixed-cutoff 15M',async()=>{
  const names=Array.from({length:25},(_,i)=>'COIN'+i+'USDT'); const {client,calls}=setup({symbols:names});const result=await client.scan();
  assert.equal(result.total,25);assert.equal(result.completed,25);assert.equal(result.matches.length,25);assert.equal(result.errors,0);
  const klines=calls.filter(u=>u.pathname.endsWith('/klines'));assert.equal(klines.length,25);
  assert.ok(klines.every(u=>u.searchParams.get('interval')==='15m'&&Number(u.searchParams.get('endTime'))===NOW-1&&Number(u.searchParams.get('limit'))===250));
  assert.ok(!calls.some(u=>u.pathname.endsWith('/ticker/24hr')));
});
test('same closed-bar scans reuse valid results, next candle refetches, errors remain explicit',async()=>{
  const {client,calls,setNow}=setup();await client.scan();await client.scan();assert.equal(calls.filter(u=>u.pathname.endsWith('/klines')).length,2);
  setNow(NOW+STEP);await client.scan();assert.equal(calls.filter(u=>u.pathname.endsWith('/klines')).length,4);
  const broken=setup({fetch:async u=>({ok:true,status:200,json:async()=>u.pathname.endsWith('/time')?{serverTime:NOW}:u.pathname.endsWith('exchangeInfo')?info(['BTCUSDT']):[]})});
  const result=await broken.client.scan();assert.equal(result.errors,1);assert.equal(result.matches.length,0);assert.equal(result.failures[0].symbol,'BTCUSDT');
});
test('catalog filters inactive, dated and non-USDT contracts and deduplicates symbols',async()=>{
  const catalog=info(['BTCUSDT','BTCUSDT']);catalog.symbols.push({...catalog.symbols[0],symbol:'ETHUSDT',status:'SETTLING'},{...catalog.symbols[0],symbol:'BTCUSD_PERP',quoteAsset:'USD'},{...catalog.symbols[0],symbol:'BTCUSDT_261225',contractType:'CURRENT_QUARTER'});
  const {client}=setup({fetch:async u=>({ok:true,status:200,json:async()=>u.pathname.endsWith('/time')?{serverTime:NOW}:u.pathname.endsWith('exchangeInfo')?catalog:rows()})});
  assert.equal((await client.scan()).total,1);
});
test('abort and exchange rate limits stop the scan without fabricated complete results',async()=>{
  const controller=new AbortController();controller.abort();const {client,calls}=setup();await assert.rejects(client.scan({signal:controller.signal}),{name:'AbortError'});assert.equal(calls.length,0);
  const limited=setup({fetch:async()=>({ok:false,status:429,headers:{get:()=> '120'}})});
  await assert.rejects(limited.client.scan(),e=>e.retryAt===NOW+120000);await assert.rejects(limited.client.scan(),/限流/);assert.equal(limited.calls.length,1);
});
test('mid-scan cancellation rejects completion and does not publish a post-abort match',async()=>{
  const controller=new AbortController(),states=[];
  const {client}=setup({fetch:async u=>({ok:true,status:200,json:async()=>{
    if(u.pathname.endsWith('/time'))return {serverTime:NOW};
    if(u.pathname.endsWith('exchangeInfo'))return info(['BTCUSDT','ETHUSDT']);
    controller.abort();return rows();
  }})});
  await assert.rejects(client.scan({signal:controller.signal,onProgress:s=>states.push(s)}),{name:'AbortError'});
  assert.ok(states.every(s=>s.matches.length===0));
});
