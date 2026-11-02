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
  const broken=setup({fetch:async parsed=>({ok:true,status:200,json:async()=>parsed.pathname.endsWith('/time')?{serverTime:NOW}:parsed.pathname.endsWith('exchangeInfo')?exchange():parsed.pathname.endsWith('/ticker/24hr')?[{symbol:'BTCUSDT',quoteVolume:'10'},{symbol:'ETHUSDT',quoteVolume:'20'}]:[]})});
  const result=await broken.client.scan();assert.equal(result.candidates.length,0);assert.equal(result.errors,2);
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
