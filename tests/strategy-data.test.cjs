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
    }else if(parsed.pathname.endsWith('/ticker/24hr'))data=[{symbol:'BTCUSDT',quoteVolume:'10000'},{symbol:'ETHUSDT',quoteVolume:'20000'}];
    else data=rows(parsed.searchParams.get('interval'),parsed.searchParams.get('symbol')==='ETHUSDT'?'FLAT':'LONG',now);
    return {ok:true,status:200,json:async()=>data};
  };
  return {client:createClient({fetcher,intervalMs:0,clock:()=>now,sleep:async()=>{}}),calls,setNow:value=>now=value};
}
test('scans both independent EMA timeframe pairs for every Top20 contract',async()=>{
 const {client,calls}=setup(),states=[];const result=await client.scan({onProgress:state=>states.push(state)});
 assert.equal(result.total,2);assert.equal(result.completed,2);assert.equal(result.candidates.length,0);assert.equal(result.errors,0);
 assert.equal(result.rankedMarkets.length,2);assert.equal(result.observations.length,2);
 assert.deepEqual([...new Set(result.observations.map(o=>o.profileId))].sort(),['4h15m']);
 const klines=calls.filter(u=>u.pathname.endsWith('klines'));assert.equal(klines.length,4);
 assert.deepEqual([...new Set(klines.map(u=>u.searchParams.get('interval')))].sort(),['15m','4h'].sort());
 assert.ok(klines.every(u=>Number(u.searchParams.get('endTime'))===NOW-1));assert.ok(states.length>=3);
});

test('only the current 4H/15M MACD strategy emits entry candidates',async()=>{
 const {fixture,NOW:time}=require('./macd-fixtures.cjs'),B=require('../site/macd-engine.js'),f=fixture(),pairs={'4h':f.higher,'15m':f.lower};
 const client=createClient({intervalMs:0,clock:()=>time,fetcher:async url=>{const u=new URL(url);return{ok:true,status:200,json:async()=>u.pathname.endsWith('/time')?{serverTime:time}:u.pathname.endsWith('exchangeInfo')?exchange(['BTCUSDT']):u.pathname.endsWith('/ticker/24hr')?[{symbol:'BTCUSDT',quoteVolume:'10000'}]:pairs[u.searchParams.get('interval')]};}});
 const r=await client.scan();assert.equal(r.errors,0);assert.equal(r.candidates.length,1);assert.equal(r.candidates[0].strategyVersion,B.VERSION);assert.deepEqual(r.filters.macd,[12,26,9]);
});

test('caches each timeframe only until its own next candle boundary',async()=>{
  const {client,calls,setNow}=setup();await client.scan();const before=calls.filter(u=>u.pathname.endsWith('klines')).length;
  await client.scan();assert.equal(calls.filter(u=>u.pathname.endsWith('klines')).length,before);
  setNow(NOW+900000);await client.scan();const newCalls=calls.filter(u=>u.pathname.endsWith('klines')).slice(before);
  assert.equal(newCalls.length,2);assert.ok(newCalls.every(u=>['15m'].includes(u.searchParams.get('interval'))));
  await assert.rejects(client.candles('BTCUSDT','1m',NOW),/只允許/);
  await assert.rejects(client.candles('BTCUSDT','30m',NOW),/只允許/);
});
test('rate limits stop further requests and honor Retry-After',async()=>{
  const {client,calls}=setup({fetch:async()=>({status:429,ok:false,headers:{get:()=> '120'},json:async()=>({})})});
  await assert.rejects(client.scan(),error=>error.retryAt===NOW+120000);
  await assert.rejects(client.scan(),/限流/);assert.equal(calls.length,1);
});
test('aborted scans and exchange failures do not fabricate candidates',async()=>{
  const aborted=new AbortController();aborted.abort();const {client,calls}=setup();
  await assert.rejects(client.scan({signal:aborted.signal}),{name:'AbortError'});assert.equal(calls.length,0);
  const broken=setup({fetch:async parsed=>({ok:true,status:200,json:async()=>parsed.pathname.endsWith('/time')?{serverTime:NOW}:parsed.pathname.endsWith('exchangeInfo')?exchange():parsed.pathname.endsWith('/ticker/24hr')?[{symbol:'BTCUSDT',quoteVolume:'10'},{symbol:'ETHUSDT',quoteVolume:'20'}]:[]})});
  const result=await broken.client.scan();assert.equal(result.candidates.length,0);assert.equal(result.errors,2);assert.equal(result.observations.length,2);assert.ok(result.observations.every(o=>o.status==="ERROR"&&o.reason));
});

test('only the top 20 by numeric USDT turnover enter strategy scanning',async()=>{
  const names=Array.from({length:25},(_,i)=>'COIN'+i+'USDT'),calls=[];
  const info=exchange([...names,'NOQUOTEUSDT','NANUSDT','ZEROUSDT']);
  info.symbols.push({...info.symbols[0],symbol:'DELISTEDUSDT',status:'SETTLING'},
    {...info.symbols[0],symbol:'BTCUSD_PERP',quoteAsset:'USD'},
    {...info.symbols[0],symbol:'QUARTERUSDT',contractType:'CURRENT_QUARTER'});
  const ticker=names.map((symbol,i)=>({symbol,quoteVolume:String(100+i),volume:String(100000-i)}));
  ticker.push({symbol:'COIN0USDT',quoteVolume:'999999999',st:2},
    {symbol:'DELISTEDUSDT',quoteVolume:'999999999'}, {symbol:'BTCUSD_PERP',quoteVolume:'999999999'},
    {symbol:'QUARTERUSDT',quoteVolume:'999999999'}, {symbol:'NOQUOTEUSDT',volume:'999999999'},
    {symbol:'NANUSDT',quoteVolume:'NaN'}, {symbol:'ZEROUSDT',quoteVolume:'0'});
  const client=createClient({intervalMs:0,fetcher:async url=>{
    const parsed=new URL(url);calls.push(parsed);
    return{ok:true,status:200,json:async()=>parsed.pathname.endsWith('/time')?{serverTime:NOW}:
      parsed.pathname.endsWith('exchangeInfo')?info:parsed.pathname.endsWith('/ticker/24hr')?ticker:
      rows(parsed.searchParams.get('interval'),'LONG',NOW)};
  }});
  const result=await client.scan();
  assert.equal(result.total,20);assert.equal(result.completed,20);assert.equal(result.errors,0);
  assert.deepEqual(result.symbols,[...names].reverse().slice(0,20));
  const requested=new Set(calls.filter(url=>url.pathname.endsWith('/klines')).map(url=>url.searchParams.get('symbol')));
  assert.equal(requested.size,20);assert.ok(!requested.has('COIN4USDT'));
  assert.ok(!requested.has('DELISTEDUSDT'));assert.ok(!requested.has('NOQUOTEUSDT'));
});

test('turnover ranking refreshes each round while contract metadata remains cached',async()=>{
  let round=0,catalogCalls=0;
  const names=Array.from({length:21},(_,i)=>'COIN'+i+'USDT');
  const client=createClient({intervalMs:0,fetcher:async url=>({ok:true,status:200,json:async()=>{
    if(url.endsWith('exchangeInfo')){catalogCalls++;return exchange(names);}
    round++;
    return names.map((symbol,i)=>({symbol,quoteVolume:String(round===1?100+i:200-i)}));
  }})});
  const first=await client.topMarkets(),second=await client.topMarkets();
  assert.equal(catalogCalls,1);assert.equal(round,2);
  assert.equal(first[0].symbol,'COIN20USDT');assert.equal(second[0].symbol,'COIN0USDT');
  assert.ok(!first.some(item=>item.symbol==='COIN0USDT'));assert.ok(!second.some(item=>item.symbol==='COIN20USDT'));
});

test('missing or malformed turnover data stops scanning rather than widening its scope',async()=>{
  for(const payload of [[],{},[{symbol:'BTCUSDT',quoteVolume:null}],[{symbol:'BTCUSDT',quoteVolume:'Infinity'}]]){
    const calls=[];
    const client=createClient({intervalMs:0,fetcher:async url=>{calls.push(url);return{ok:true,status:200,json:async()=>
      url.endsWith('/time')?{serverTime:NOW}:url.endsWith('exchangeInfo')?exchange():payload};}});
    await assert.rejects(client.scan(),/成交額/);
    assert.ok(!calls.some(url=>url.includes('/klines')));
  }
});

test('crypto and TradFi share ONE Top20 ranking with official contract types',async()=>{
 const names=Array.from({length:24},(_,i)=>'M'+i+'USDT'),info=exchange(names);info.symbols.forEach((m,i)=>m.contractType=i%2?'TRADIFI_PERPETUAL':'PERPETUAL');info.symbols.push({...info.symbols[0],symbol:'QUARTERUSDT',contractType:'CURRENT_QUARTER'});
 const client=createClient({intervalMs:0,fetcher:async url=>({ok:true,status:200,json:async()=>url.endsWith('exchangeInfo')?info:url.endsWith('/ticker/24hr')?[...names.map((symbol,i)=>({symbol,quoteVolume:String(i+1)})),{symbol:'QUARTERUSDT',quoteVolume:'999999'}]:{serverTime:NOW}})});
 const ranked=await client.topMarkets();assert.equal(ranked.length,20);assert.deepEqual(ranked.map(m=>m.symbol),names.slice(4).reverse());assert.equal(ranked.filter(m=>m.contractType==='PERPETUAL').length,10);assert.equal(ranked.filter(m=>m.contractType==='TRADIFI_PERPETUAL').length,10);
});
test('TradFi candidates and observations retain their classification',async()=>{
 const {fixture,NOW:time}=require('./macd-fixtures.cjs'),f=fixture(),pairs={'4h':f.higher,'15m':f.lower},info=exchange(['XAUUSDT']);info.symbols[0].contractType='TRADIFI_PERPETUAL';
 const client=createClient({intervalMs:0,clock:()=>time,fetcher:async url=>{const u=new URL(url);return{ok:true,status:200,json:async()=>u.pathname.endsWith('/time')?{serverTime:time}:u.pathname.endsWith('exchangeInfo')?info:u.pathname.endsWith('/ticker/24hr')?[{symbol:'XAUUSDT',quoteVolume:'10000'}]:pairs[u.searchParams.get('interval')]};}});
 const r=await client.scan();assert.equal(r.errors,0);assert.equal(r.candidates.length,1);assert.equal(r.observations[0].contractType,'TRADIFI_PERPETUAL');assert.equal(r.candidates[0].market.contractType,'TRADIFI_PERPETUAL');
});
