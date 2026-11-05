const test=require('node:test'),assert=require('node:assert/strict'),N=require('../site/news-radar-data.js');
const now=Date.UTC(2026,10,5),article=(title,code='a'.repeat(32),at=now-60000)=>({title,code,releaseDate:at});
test('news only matches signal assets, including multiplier contracts and ticker boundaries',()=>{
 assert.equal(N.matches('Binance Will List BTCUSDT and ETHUSDT','BTCUSDT'),true);assert.equal(N.matches('Bitcoin announcement','BTCUSDT'),true);assert.equal(N.matches('PEPEUSDT notice','1000PEPEUSDT'),true);assert.equal(N.baseAsset('1INCHUSDT'),'1INCH');assert.equal(N.matches('Binance futures announcement','BNBUSDT'),false);assert.equal(N.matches('BTCC starts promotion','BTCUSDT'),false);assert.equal(N.matches('SOLVUSDT notice','SOLUSDT'),false);
 const rows=N.select([article('BTCUSDT upgrade'),article('ETHUSDT announcement','b'.repeat(32))],['BTCUSDT'],{now,days:7});assert.equal(rows.length,1);assert.deepEqual(rows[0].symbols,['BTCUSDT']);assert.ok(rows[0].url.startsWith('https://www.binance.com/'));
});
test('unrelated, unsafe, future and stale news are hidden and duplicates merge',()=>{
 const a=article('Binance BTCUSDT upgrade'),b=article('DOGEUSDT notice','b'.repeat(32));assert.equal(N.select([a,a,b,article('BTCUSDT unsafe','javascript:bad'),article('BTCUSDT future','c'.repeat(32),now+86400000),article('BTCUSDT old','d'.repeat(32),now-8*86400000)],['BTCUSDT'],{now,days:7}).length,1);assert.equal(N.select([a],[],{now}).length,0);
});
test('title classification is provisional, mixed headlines are neutral',()=>{
 assert.equal(N.classify('Binance Will List ABC').sentiment,'bullish');assert.equal(N.classify('Binance Will Delist ABC').sentiment,'bearish');assert.equal(N.classify('Binance Adds XYZ and Suspends ABC').sentiment,'neutral');assert.equal(N.classify('BTCUSDT notice').sentiment,'neutral');assert.equal(N.classify('Predict Listing Will Be Postponed').sentiment,'bearish');assert.equal(N.classify('Binance Will Launch ABCUSDT').sentiment,'bullish');assert.equal(N.classify('Binance Will Delist ABC').major,true);
});
test('client caches source requests and filters new symbols without widening its scope',async()=>{
 let calls=0;const client=N.createClient({clock:()=>now,fetcher:async()=>{calls++;return{ok:true,json:async()=>({code:'000000',data:{catalogs:[{articles:[article('BTCUSDT upgrade')]}]}})};}});assert.equal((await client.load({symbols:['BTCUSDT']})).articles.length,1);assert.equal(calls,3);assert.equal((await client.load({symbols:['ETHUSDT']})).articles.length,0);assert.equal(calls,3);await client.load({symbols:['BTCUSDT'],force:true});assert.equal(calls,6);
});
test('source failures are errors, not fabricated empty news results',async()=>{
 const client=N.createClient({fetcher:async()=>({ok:false,status:429})});await assert.rejects(client.load({symbols:['BTCUSDT']}),/無法連線/);let calls=0;await N.createClient({fetcher:async()=>{calls++;}}).load({symbols:[]});assert.equal(calls,0);
});
