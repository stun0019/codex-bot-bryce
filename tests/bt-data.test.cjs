const assert=require('node:assert/strict'),test=require('node:test');
const {createClient}=require('../site/bt-data.js');
const START=Date.UTC(2026,10,1),STEP=900000;
function setup(options={}){
  const cache=new Map(),calls=[];const store={get:async(_,id)=>cache.get(id),put:async(_,value)=>cache.set(value.id,value)};
  const fetcher=async(url,init)=>{calls.push(new URL(url));if(options.fetch)return options.fetch(new URL(url),init);
    const query=new URL(url).searchParams,start=Number(query.get('startTime')),end=Number(query.get('endTime'));
    const rows=[];for(let at=start;at<=end&&rows.length<499;at+=STEP)rows.push([at,100,101,99,100,50,at+STEP-1,5000]);
    return{ok:true,status:200,json:async()=>rows};};
  return{client:createClient({store,fetcher,spacing:0}),calls,cache};
}
test('paginates full historical ranges, caches completed series and reuses exact queries',async()=>{
  const {client,calls}=setup();const result=await client.range('BTCUSDT','15m',START,START+700*STEP);
  assert.equal(result.rows.length,700);assert.equal(calls.length,2);assert.equal(calls[1].searchParams.get('startTime'),String(START+499*STEP));
  await client.range('BTCUSDT','15m',START,START+700*STEP);assert.equal(calls.length,2);
});
test('rejects partial or missing historical data instead of caching incomplete results',async()=>{
  const {client,cache}=setup({fetch:async()=>({ok:true,status:200,json:async()=>[]})});
  await assert.rejects(client.range('BTCUSDT','15m',START,START+STEP),/沒有/);assert.equal(cache.size,0);
});
test('cancellation does not cache unfinished history',async()=>{
  const {client,cache,calls}=setup(),controller=new AbortController();controller.abort();
  await assert.rejects(client.range('BTCUSDT','15m',START,START+STEP,controller.signal),{name:'AbortError'});
  assert.equal(calls.length,0);assert.equal(cache.size,0);
});
test('unsupported intervals fail and exchange rate limits stop requests',async()=>{
  const {client}=setup({fetch:async()=>({ok:false,status:429})});
  await assert.rejects(client.range('BTCUSDT','1m',START,START+STEP),/不支援/);
  await assert.rejects(client.range('BTCUSDT','15m',START,START+STEP),/限流/);
});
