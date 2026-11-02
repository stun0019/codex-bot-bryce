const assert=require('node:assert/strict');
const test=require('node:test');
const {createClient}=require('../site/strategy-data.js');
const {NOW,rows,exchange}=require('./strategy-fixtures.cjs');
function setup(options={}){
  const calls=[];let now=NOW;
  const fetcher=async url=>{
    const parsed=new URL(url);calls.push(parsed);
    if(options.fetch)return options.fetch(parsed);
    let data;
    if(parsed.pathname.endsWith('/time'))data={serverTime:now};
    else if(parsed.pathname.endsWith('/exchangeInfo')){
      data=exchange();data.symbols.push({...data.symbols[0],symbol:'DELISTEDUSDT',status:'SETTLING'},
        {...data.symbols[0],symbol:'BTCUSD_PERP',quoteAsset:'USD'}, {...data.symbols[0],symbol:'BTCUSDT_261225',contractType:'CURRENT_QUARTER'});
    }else data=rows(parsed.searchParams.get('interval'),parsed.searchParams.get('symbol')==='ETHUSDT'?'FLAT':'LONG',now);
    return {ok:true,status:200,json:async()=>data};
  };
  return {client:createClient({fetcher,intervalMs:0,clock:()=>now,sleep:async()=>{}}),calls,setNow:value=>now=value};
}
test('scans active USDT perpetuals with only 4H and 15M, fetching entries only after trend passes',async()=>{
  const {client,calls}=setup(),states=[];const result=await client.scan({onProgress:state=>states.push(state)});
  assert.equal(result.total,2);assert.equal(result.completed,2);assert.equal(result.trending,1);assert.equal(result.candidates.length,1);assert.equal(result.candidates[0].symbol,'BTCUSDT');
  const klines=calls.filter(url=>url.pathname.endsWith('klines'));
  assert.equal(klines.length,3);assert.ok(klines.every(url=>['4h','15m'].includes(url.searchParams.get('interval'))));
  assert.ok(!klines.some(url=>url.searchParams.get('symbol')==='ETHUSDT'&&url.searchParams.get('interval')==='15m'));
  assert.ok(klines.every(url=>Number(url.searchParams.get('endTime'))===NOW-1));assert.ok(states.length>=3);
});
test('caches each timeframe only until its own next candle boundary',async()=>{
  const {client,calls,setNow}=setup();await client.scan();const before=calls.filter(u=>u.pathname.endsWith('klines')).length;
  await client.scan();assert.equal(calls.filter(u=>u.pathname.endsWith('klines')).length,before);
  setNow(NOW+900000);await client.scan();const newCalls=calls.filter(u=>u.pathname.endsWith('klines')).slice(before);
  assert.equal(newCalls.length,1);assert.equal(newCalls[0].searchParams.get('interval'),'15m');
  await assert.rejects(client.candles('BTCUSDT','1h',NOW),/只允許/);
  await assert.rejects(client.candles('BTCUSDT','5m',NOW),/只允許/);
});
test('rate limits stop further requests and honor Retry-After',async()=>{
  const {client,calls}=setup({fetch:async()=>({status:429,ok:false,headers:{get:()=> '120'},json:async()=>({})})});
  await assert.rejects(client.scan(),error=>error.retryAt===NOW+120000);
  await assert.rejects(client.scan(),/限流/);assert.equal(calls.length,1);
});
test('aborted scans and exchange failures do not fabricate candidates',async()=>{
  const aborted=new AbortController();aborted.abort();const {client,calls}=setup();
  await assert.rejects(client.scan({signal:aborted.signal}),{name:'AbortError'});assert.equal(calls.length,0);
  const broken=setup({fetch:async parsed=>({ok:true,status:200,json:async()=>parsed.pathname.endsWith('/time')?{serverTime:NOW}:parsed.pathname.endsWith('exchangeInfo')?exchange():[]})});
  const result=await broken.client.scan();assert.equal(result.candidates.length,0);assert.equal(result.errors,2);
});
