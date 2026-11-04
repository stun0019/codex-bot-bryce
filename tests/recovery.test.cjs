const test=require('node:test'),assert=require('node:assert/strict');
const P=require('../site/paper-engine.js'),R=require('../site/paper-recovery.js');
const NOW=1800000000000;
function setup(direction='LONG'){
 const m=P.createModel({version:1,settings:{enabled:true,feeRate:0,slippage:0},trades:[]});
 const c={symbol:'BTCUSDT',direction,confirmedAt:NOW-1000,expiresAt:NOW+900000,entry:100,stopLoss:direction==='LONG'?98:102,target:direction==='LONG'?104:96,tickSize:.01,market:{symbol:'BTCUSDT',stepSize:.001,minQty:.001,maxQty:1000,minNotional:5}};
 m.addCandidates([c],70,NOW-1);m.tick(c.symbol,100,NOW,{aggregateId:100});return{m,t:m.trades[0]};
}
const row=(id,price=100,at=NOW+(id-100)*1000)=>({id,price,at});
function proof(rows,complete=true,head=rows.at(-1)){return{symbol:'BTCUSDT',anchor:rows[0],head,rows,complete};}
const states=t=>t.targets.map(t=>t.status);
function clientFor(rows,{clock=()=>NOW+60000,maxPages=20,fetch:override}={}){
 const calls=[];const client=R.createClient({clock,spacing:0,maxPages,sleep:async()=>{},fetcher:async url=>{
  const u=new URL(url);calls.push(u);if(override)return override(u);
  const from=u.searchParams.get('fromId'),selected=from===null?rows.slice(-1):rows.filter(r=>r.id>=Number(from)).slice(0,1000);
  return{ok:true,status:200,json:async()=>selected.map(r=>({a:r.id,T:r.at,p:String(r.price)}))};
 }});return{client,calls};
}
test('refresh preserves open positions and frozen settings in a durable recovery checkpoint',()=>{
 const {m,t}=setup();m.suspend('refresh',NOW+1000);assert.equal(t.status,'OPEN');assert.equal(t.recovery.pending,true);assert.equal(m.stats().recovering,1);assert.equal(m.stats().review,0);
 const loaded=P.createModel(JSON.parse(JSON.stringify(m.snapshot())));loaded.settings.feeRate=.01;
 loaded.applyRecovery(proof([row(100),row(101,101),row(102,102)]),NOW+5000);
 const trade=loaded.trades[0];assert.equal(trade.status,'OPEN');assert.equal(trade.recovery.pending,false);assert.equal(trade.feeRate,0);assert.equal(trade.entry,100);assert.equal(trade.quantity,t.quantity);assert.equal(trade.checkpoint.id,102);
});
test('a historical stop before a later rebound is recorded once and never resumed as open',()=>{
 const {m,t}=setup();m.suspend('offline',NOW+5000);m.applyRecovery(proof([row(100),row(101,97),row(102,110)]),NOW+10000);
 assert.equal(t.status,'STOP_LOSS');assert.equal(t.exit,97);assert.deepEqual(states(t),['STOPPED','STOPPED','STOPPED']);assert.equal(m.stats().reconciledClosed,1);assert.equal(m.stats().closed,1);
 m.tick('BTCUSDT',110,NOW+20000,{aggregateId:102});assert.equal(m.stats().closed,1);assert.equal(t.exit,97);
});
test('recovery preserves TP1 and continues TP2/TP3 after primary profit',()=>{
 const {m,t}=setup();m.tick('BTCUSDT',104,NOW+1000,{aggregateId:101});const pnl=t.netPnl;
 m.suspend('reload',NOW+2000);assert.equal(t.status,'TAKE_PROFIT');assert.equal(m.stats().recovering,1);assert.equal(m.stats().targets.levels[1].recovering,1);
 m.applyRecovery(proof([row(101,104),row(102,106),row(103,108)]),NOW+10000);
 assert.deepEqual(states(t),['HIT','HIT','HIT']);assert.equal(t.netPnl,pnl);assert.equal(t.exitSource,'live');assert.equal(m.stats().reconciledClosed,0);assert.deepEqual(m.activeSymbols(),[]);
});
test('short recovery uses the same chronological stop and target rules',()=>{
 const {m,t}=setup('SHORT');m.suspend('offline',NOW+1000);m.applyRecovery(proof([row(100),row(101,96),row(102,94),row(103,92)]),NOW+5000);
 assert.equal(t.status,'TAKE_PROFIT');assert.deepEqual(states(t),['HIT','HIT','HIT']);assert.equal(t.exit,96);
});
test('live missing IDs or a 30-second gap queue recovery without consuming the current quote',()=>{
 for(const mode of ['id','time']){const {m,t}=setup();m.tick('BTCUSDT',104,mode==='id'?NOW+1000:NOW+31000,{aggregateId:mode==='id'?102:101});
  assert.equal(t.recovery.pending,true);assert.equal(t.status,'OPEN');assert.equal(t.checkpoint.id,100);assert.deepEqual(states(t),['PENDING','PENDING','PENDING']);
 }
});
test('duplicate and older ticks never advance a checkpoint or double count targets',()=>{
 const {m,t}=setup();m.tick('BTCUSDT',101,NOW+1000,{aggregateId:101});m.tick('BTCUSDT',108,NOW+1000,{aggregateId:101});m.tick('BTCUSDT',108,NOW+500,{aggregateId:100});
 assert.equal(t.status,'OPEN');assert.equal(t.lastPrice,101);assert.equal(t.checkpoint.id,101);assert.deepEqual(states(t),['PENDING','PENDING','PENDING']);
});
test('pending recovery blocks unaudited live prices and pending entries are not backfilled',()=>{
 const {m,t}=setup();m.suspend('reload',NOW+1000);m.tick('BTCUSDT',90,NOW+2000,{aggregateId:101});assert.equal(t.status,'OPEN');assert.equal(t.lastPrice,100);
 const next={symbol:'ETHUSDT',direction:'LONG',confirmedAt:NOW,expiresAt:NOW+900000,entry:100,stopLoss:98,target:104,tickSize:.01,market:{stepSize:.001,minNotional:5}};
 m.addCandidates([next],70,NOW+1000);m.suspend('refresh',NOW+2000);assert.equal(m.trades[1].status,'SKIPPED');
});
test('timer expiry suspends checkpointed positions while legacy records remain conservative',()=>{
 const {m,t}=setup();m.expire(NOW+31000);assert.equal(t.status,'OPEN');assert.equal(t.recovery.pending,true);
 const legacy=JSON.parse(JSON.stringify(m.snapshot()));delete legacy.trades[0].checkpoint;delete legacy.trades[0].recovery;
 const loaded=P.createModel(legacy);loaded.suspend('reload',NOW+32000);assert.equal(loaded.trades[0].status,'REVIEW');assert.equal(loaded.stats().legacyReview,1);assert.equal(loaded.recoveryTasks().length,0);
});
test('incomplete proof chunks advance durably while remaining in recovery',()=>{
 const {m,t}=setup();m.suspend('reload',NOW+1000);m.applyRecovery(proof([row(100),row(101,101)],false,row(103,103)),NOW+5000);
 assert.equal(t.checkpoint.id,101);assert.equal(t.recovery.pending,true);const loaded=P.createModel(JSON.parse(JSON.stringify(m.snapshot())));
 loaded.applyRecovery(proof([row(101,101),row(102,102),row(103,103)]),NOW+6000);assert.equal(loaded.trades[0].recovery.pending,false);assert.equal(loaded.trades[0].checkpoint.id,103);
});
test('a trade can resolve inside a proof chunk without requiring later unrelated history',()=>{
 const {m,t}=setup();m.suspend('reload',NOW+1000);m.applyRecovery(proof([row(100),row(101,90)],false,row(1000,100)),NOW+5000);
 assert.equal(t.status,'STOP_LOSS');assert.equal(t.recovery.pending,false);assert.equal(t.checkpoint.id,101);
});
test('invalid history proof does not partially mutate positions',()=>{
 const {m}=setup();m.suspend('reload',NOW+1000);const before=JSON.stringify(m.snapshot());
 for(const rows of [[row(100),row(102,90)],[row(100,99),row(101,90)],[row(100),row(101,90,NOW-1)]])assert.throws(()=>m.applyRecovery(proof(rows),NOW+5000));
 assert.equal(JSON.stringify(m.snapshot()),before);
});
test('permanent failure reviews unresolved targets only; manual retry preserves confirmed hits',()=>{
 const {m,t}=setup();m.tick('BTCUSDT',104,NOW+1000,{aggregateId:101});m.suspend('reload',NOW+2000);
 m.recoveryError('BTCUSDT',R.failure('HISTORY_GAP','gap',true),NOW+3000);assert.deepEqual(states(t),['HIT','REVIEW','REVIEW']);assert.equal(t.status,'TAKE_PROFIT');assert.equal(m.stats().recovering,0);
 assert.equal(m.retryRecovery(NOW+4000),true);m.applyRecovery(proof([row(101,104),row(102,106),row(103,108)]),NOW+5000);
 assert.deepEqual(states(t),['HIT','HIT','HIT']);assert.equal(t.status,'TAKE_PROFIT');
});
test('temporary failure keeps positions recoverable with backoff, excluded from closed win rate',()=>{
 const {m,t}=setup();m.suspend('reload',NOW+1000);m.recoveryError('BTCUSDT',R.failure('RATE_LIMIT','retry',false,{retryAt:NOW+120000}),NOW+2000);
 assert.equal(t.status,'OPEN');assert.equal(t.recovery.pending,true);assert.equal(m.recoveryTasks(NOW+10000).length,0);assert.equal(m.recoveryTasks(NOW+120000).length,1);assert.equal(m.stats().closed,0);
});
test('client paginates inclusive IDs and pins a bridge head',async()=>{
 const rows=Array.from({length:2100},(_,i)=>row(100+i,100,NOW+i));const {client,calls}=clientFor(rows);
 const result=await client.range('BTCUSDT',rows[0]);assert.equal(result.complete,true);assert.equal(result.rows.length,2100);assert.equal(calls.length,4);
 assert.deepEqual(calls.slice(1).map(u=>u.searchParams.get('fromId')),['100','1100','2100']);assert.ok(calls.every(u=>!u.searchParams.has('startTime')));
});
test('client rejects missing, duplicated, nonmonotonic and mismatched anchor history',async()=>{
 for(const rows of [[row(100),row(102)],[row(100),row(100),row(101)],[row(100),row(101,100,NOW-1),row(102)],[row(100,101),row(101)]]){
  const {client}=clientFor(rows);await assert.rejects(client.range('BTCUSDT',row(100)),error=>error.permanent===true);
 }
});
test('client commits bounded chunks and rejects stale checkpoints before fetching',async()=>{
 const rows=Array.from({length:1200},(_,i)=>row(100+i,100,NOW+i));const {client}=clientFor(rows,{maxPages:1});const out=await client.range('BTCUSDT',rows[0]);assert.equal(out.complete,false);assert.equal(out.rows.length,1000);
 const old=clientFor(rows,{clock:()=>NOW+48*3600000});await assert.rejects(old.client.range('BTCUSDT',rows[0]),{code:'OUT_OF_RANGE'});assert.equal(old.calls.length,0);
});
test('rate limits honor Retry-After and abort cancels without producing proof',async()=>{
 const limited=clientFor([],{fetch:async()=>({ok:false,status:429,headers:{get:()=> '120'}})});
 await assert.rejects(limited.client.range('BTCUSDT',row(100)),error=>error.code==='RATE_LIMIT'&&error.retryAt===NOW+180000);
 await assert.rejects(limited.client.range('BTCUSDT',row(100)),{code:'RATE_LIMIT'});assert.equal(limited.calls.length,1);
 const abort=new AbortController();abort.abort();const stopped=clientFor([row(100)]);await assert.rejects(stopped.client.range('BTCUSDT',row(100),abort.signal),{name:'AbortError'});assert.equal(stopped.calls.length,0);
});
test('coordinator merges buffered live trades after historical proof and deduplicates the bridge',async()=>{
 const {m,t}=setup();m.suspend('reload',NOW+1000);let release;const gate=new Promise(r=>{release=r;});
 const c=R.createCoordinator({model:m,clock:()=>NOW+10000,client:{async range(){await gate;return proof([row(100),row(101,101)]);}}});
 const run=c.recover();c.accept({pair:'BTC-USDT',nativeSymbol:'BTCUSDT',kind:'aggTrade',aggregateId:101,price:101,timestamp:NOW+1000});c.accept({pair:'BTC-USDT',nativeSymbol:'BTCUSDT',kind:'aggTrade',aggregateId:102,price:104,timestamp:NOW+2000});release();await run;
 assert.equal(t.status,'TAKE_PROFIT');assert.equal(t.exitSource,'live');assert.equal(t.checkpoint.id,102);assert.equal(t.recovery.pending,false);assert.equal(m.stats().closed,1);
});
test('a buffer gap queues another recovery instead of accepting an unverified latest quote',async()=>{
 const {m,t}=setup();m.suspend('reload',NOW+1000);
 const c=R.createCoordinator({model:m,clock:()=>NOW+10000,client:{async range(){return proof([row(100),row(101,101)]);}}});
 c.accept({pair:'BTC-USDT',nativeSymbol:'BTCUSDT',kind:'aggTrade',aggregateId:103,price:104,timestamp:NOW+3000});await c.recover();
 assert.equal(t.status,'OPEN');assert.equal(t.checkpoint.id,101);assert.equal(t.recovery.pending,true);
});
test('coordinator excludes ticker-only and scaled alias quotes from native checkpoints',()=>{
 const {m,t}=setup(),c=R.createCoordinator({model:m});
 assert.equal(c.accept({pair:'BTC-USDT',nativeSymbol:'BTCUSDT',kind:'24hrTicker',aggregateId:101,price:104,timestamp:NOW+1000}),false);
 assert.equal(c.accept({pair:'PEPE-USDT',nativeSymbol:'1000PEPEUSDT',kind:'aggTrade',aggregateId:101,price:.0001,timestamp:NOW+1000}),false);assert.equal(t.checkpoint.id,100);
});

test('same-symbol positions with different checkpoints recover in order across proof chunks',async()=>{
 const {m,t}=setup();m.suspend('reload',NOW+500);
 const c={symbol:'BTCUSDT',direction:'LONG',confirmedAt:NOW+500,expiresAt:NOW+900000,entry:100,stopLoss:98,target:104,tickSize:.01,market:{stepSize:.001,minNotional:5}};
 m.addCandidates([c],70,NOW+600);m.tick('BTCUSDT',100,NOW+2000,{aggregateId:102});m.suspend('reload',NOW+3000);
 let clock=NOW+4000,calls=0;const coordinator=R.createCoordinator({model:m,clock:()=>clock,client:{async range(symbol,anchor){calls++;return calls===1?proof([row(100),row(101)],false,row(103)):proof([row(101),row(102),row(103)]);}}});
 await coordinator.recover();assert.equal(t.checkpoint.id,101);assert.equal(m.trades[1].checkpoint.id,102);clock+=1000;
 await coordinator.recover();assert.equal(t.checkpoint.id,103);assert.equal(m.trades[1].checkpoint.id,103);assert.equal(m.stats().recovering,0);
});
test('aborted coordinator never applies history after a page leaves',async()=>{
 const {m,t}=setup();m.suspend('reload',NOW+1000);const controller=new AbortController();
 const c=R.createCoordinator({model:m,client:{async range(){controller.abort();return proof([row(100),row(101,90)]);}}});
 await assert.rejects(c.recover(controller.signal),{name:'AbortError'});assert.equal(t.status,'OPEN');assert.equal(t.checkpoint.id,100);assert.equal(t.recovery.pending,true);
});
test('sparse but consecutive historical IDs can safely bridge more than 30 seconds',()=>{
 const {m,t}=setup();m.suspend('reload',NOW+1000);m.applyRecovery(proof([row(100),row(101,101,NOW+120000)]),NOW+121000);assert.equal(t.status,'OPEN');assert.equal(t.recovery.pending,false);assert.equal(t.checkpoint.id,101);
});
test('corrupt saved checkpoint cursors are rejected instead of resuming invented positions',()=>{
 const {m}=setup(),saved=JSON.parse(JSON.stringify(m.snapshot()));saved.trades[0].checkpoint.id='100';assert.throws(()=>P.createModel(saved),/無效/);
});

test('a verified quiet market does not trigger another recovery on every timer tick',()=>{
 const {m,t}=setup();m.suspend('quiet',NOW+31000);m.applyRecovery({...proof([row(100)]),headCheckedAt:NOW+31000},NOW+32000);
 m.expire(NOW+33000);assert.equal(t.recovery.pending,false);m.expire(NOW+62000);assert.equal(t.recovery.pending,true);
});
test('reconciled target events retain provenance while prior live target hits remain live',()=>{
 const {m,t}=setup();m.tick('BTCUSDT',104,NOW+1000,{aggregateId:101});m.suspend('refresh',NOW+2000);m.applyRecovery(proof([row(101,104),row(102,106)]),NOW+4000);
 assert.equal(t.targets[0].source,'live');assert.equal(t.targets[1].source,'reconciled');
});

test('invalid symbols stop automatic retries and future verification timestamps are rejected',async()=>{
 const broken=clientFor([],{fetch:async()=>({ok:false,status:400,json:async()=>({code:-1121,msg:'Invalid symbol'})})});
 await assert.rejects(broken.client.range('BTCUSDT',row(100)),e=>e.permanent===true);
 const {m}=setup();m.suspend('reload',NOW+1000);assert.throws(()=>m.applyRecovery({...proof([row(100)]),headCheckedAt:NOW+999999},NOW+10000),/時間/);
});
