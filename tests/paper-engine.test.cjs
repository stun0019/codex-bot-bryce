const assert=require('node:assert/strict');
const test=require('node:test');
const {createModel,MAX_GAP_MS}=require('../site/paper-engine.js');
const NOW=1800000000000;
function candidate(patch={}) {return {symbol:'BTCUSDT',direction:'LONG',confirmedAt:NOW-60000,expiresAt:NOW+600000,
  entry:100,stopLoss:98,target:104,tickSize:.01,market:{symbol:'BTCUSDT',stepSize:.001,minQty:.001,maxQty:1000,minNotional:5},...patch};}
function model(settings={}) {return createModel({version:1,settings:{enabled:true,feeRate:0,slippage:0,...settings},trades:[]});}
function open(m,c=candidate(),price=100,at=NOW) {m.addCandidates([c],70,at);m.tick(c.symbol,price,at+1);return m.trades.at(-1);}

test('records a signal once, including across storage reloads and repeated scans',()=>{
  const m=model(),c=candidate();assert.equal(m.addCandidates([c,c],70,NOW),1);
  assert.equal(m.addCandidates([c],70,NOW+1),0);
  const restored=createModel(JSON.parse(JSON.stringify(m.snapshot())));
  assert.equal(restored.addCandidates([c],70,NOW+2),0);
});
test('waits for a new quote after signal detection and never backfills the K-line close',()=>{
  const m=model();m.addCandidates([candidate()],70,NOW);
  m.tick('BTCUSDT',99,NOW-1);assert.equal(m.trades[0].status,'WAITING_PRICE');
  m.tick('BTCUSDT',99,NOW+1);assert.equal(m.trades[0].entry,99);assert.equal(m.trades[0].referenceEntry,100);
});
test('skips expired signals, invalid levels, late quotes and entries with reward/risk below 2',()=>{
  const m=model();assert.equal(m.addCandidates([candidate({expiresAt:NOW-1})],70,NOW),0);
  open(m,candidate(),101);assert.equal(m.trades[0].status,'SKIPPED');assert.match(m.trades[0].reason,/1:2/);
  const late=model();late.addCandidates([candidate()],70,NOW);late.tick('BTCUSDT',100,NOW+MAX_GAP_MS);
  assert.equal(late.trades[0].status,'SKIPPED');
  const crossed=model();open(crossed,candidate(),105);assert.equal(crossed.trades[0].status,'SKIPPED');
});
test('long and short trades close on actual subsequent target/stop quotes',()=>{
  const m=model();const trade=open(m);assert.equal(trade.status,'OPEN');
  m.tick('BTCUSDT',104,NOW+1000);assert.equal(trade.status,'TAKE_PROFIT');assert.ok(Math.abs(trade.netPnl-4.2)<1e-10);
  const s=model();const short=open(s,candidate({direction:'SHORT',stopLoss:102,target:96}));
  s.tick('BTCUSDT',102,NOW+1000);assert.equal(short.status,'STOP_LOSS');assert.ok(Math.abs(short.netPnl+2.1)<1e-10);
});
test('includes estimated fees and stop slippage in the 3% sizing budget',()=>{
  const m=model({feeRate:.0005,slippage:.0002}),trade=open(m,candidate(),99);
  assert.equal(trade.status,'OPEN');assert.ok(trade.estimatedStopRisk<=2.1);assert.ok(trade.entry>99);
  m.tick('BTCUSDT',104,NOW+1000);
  assert.ok(trade.exit<104);assert.ok(trade.netPnl<trade.grossPnl);
  assert.ok(Math.abs(trade.netPnl-(trade.grossPnl-trade.entryFee-trade.exitFee))<1e-10);
});
test('market gaps may exceed estimated stop risk and use the observed exit quote',()=>{
  const m=model(),trade=open(m);m.tick('BTCUSDT',95,NOW+1000);
  assert.equal(trade.exit,95);assert.ok(trade.netPnl < -2.1);
});
test('candidate expiration does not terminate an open simulated trade',()=>{
  const m=model(),trade=open(m,candidate({expiresAt:NOW+3000}));
  m.expire(NOW+4000);assert.equal(trade.status,'OPEN');m.tick('BTCUSDT',104,NOW+5000);assert.equal(trade.status,'TAKE_PROFIT');
});
test('unobserved gaps, reloads and interruptions are REVIEW and excluded from win rate',()=>{
  const m=model(),trade=open(m);m.tick('BTCUSDT',104,NOW+MAX_GAP_MS+2);
  assert.equal(trade.status,'REVIEW');assert.equal(m.stats().closed,0);assert.equal(m.stats().winRate,null);
  const loaded=model();open(loaded);const next=createModel(JSON.parse(JSON.stringify(loaded.snapshot())));
  next.interrupt('reload',NOW+2000);assert.equal(next.trades[0].status,'REVIEW');
  assert.equal(next.stats().closed,0);
});
test('same-symbol new signals are independent and old ones remain tracked after scanning changes',()=>{
  const m=model();const first=open(m);const second=open(m,candidate({confirmedAt:NOW-30000}),100,NOW+10);
  assert.equal(m.trades.length,2);m.tick('BTCUSDT',104,NOW+1000);
  assert.equal(first.status,'TAKE_PROFIT');assert.equal(second.status,'TAKE_PROFIT');assert.equal(m.stats().closed,2);
});
test('pausing only blocks new records; existing positions continue to close',()=>{
  const m=model(),trade=open(m);m.settings.enabled=false;
  assert.equal(m.addCandidates([candidate({confirmedAt:NOW-10000})],70,NOW+100),0);
  m.tick('BTCUSDT',104,NOW+1000);assert.equal(trade.status,'TAKE_PROFIT');
});
test('settings and capital are frozen per recorded signal',()=>{
  const m=model(),old=open(m);m.settings.feeRate=.001;
  m.addCandidates([candidate({confirmedAt:NOW-10000})],140,NOW+1000);
  assert.equal(old.feeRate,0);assert.equal(old.budget,2.1);
  assert.equal(m.trades[1].feeRate,.001);assert.equal(m.trades[1].budget,4.2);
});
test('win rate counts net-positive closed trades only and reports loss streak/drawdown',()=>{
  const m=model();open(m);m.tick('BTCUSDT',104,NOW+1000);
  open(m,candidate({confirmedAt:NOW-20000}),100,NOW+2000);m.tick('BTCUSDT',98,NOW+3000);
  open(m,candidate({confirmedAt:NOW-10000}),100,NOW+4000);m.tick('BTCUSDT',98,NOW+5000);
  m.addCandidates([candidate({confirmedAt:NOW-5000})],70,NOW+6000);m.tick('BTCUSDT',101,NOW+6001);
  const stats=m.stats();assert.equal(stats.closed,3);assert.equal(stats.skipped,1);assert.equal(stats.wins,1);assert.equal(stats.losses,2);
  assert.ok(Math.abs(stats.winRate-100/3)<1e-10);assert.equal(stats.maxLossStreak,2);assert.ok(Math.abs(stats.maxDrawdown-4.2)<1e-10);
});
test('a target trigger with negative after-cost PnL is not a statistical win',()=>{
  const m=model({feeRate:.01}),trade=open(m,candidate({stopLoss:99.99,target:100.021,tickSize:.001}));
  assert.equal(trade.status,'OPEN');m.tick('BTCUSDT',100.021,NOW+1000);
  assert.equal(trade.status,'TAKE_PROFIT');assert.ok(trade.netPnl<0);assert.equal(m.stats().wins,0);assert.equal(m.stats().winRate,0);
});
test('minimum lot/notional limits reject untradeable sizes without adding closed samples',()=>{
  const m=model(),trade=open(m,candidate({market:{stepSize:1,minQty:100,maxQty:1000,minNotional:5}}));
  assert.equal(trade.status,'SKIPPED');assert.equal(m.stats().closed,0);
});
test('restored ledgers reject malformed records instead of producing invented statistics',()=>{
  assert.throws(()=>createModel({version:2,trades:[]}),/格式/);
  const m=model();open(m);const state=JSON.parse(JSON.stringify(m.snapshot()));
  state.trades.push(state.trades[0]);assert.throws(()=>createModel(state),/無效或重複/);
  const bad=JSON.parse(JSON.stringify(m.snapshot()));bad.trades[0].feeRate=-1;assert.throws(()=>createModel(bad),/無效/);
});
