const assert=require('node:assert/strict'),test=require('node:test');
const B=require('../site/bt-engine.js'),E=require('../site/strategy-engine.js');
const {NOW,rows,market}=require('./strategy-fixtures.cjs');
const STEP=900000,START=Math.floor(NOW/STEP)*STEP;
function fixture(patch={}){
  const fifteen=rows('15m'),four=rows('4h');
  for(const [i,o,h,l,c]of[[0,100,101,99,100],[1,100,116,99,110],[2,110,111,109,110]])fifteen.push([START+i*STEP,o,h,l,c,100,START+(i+1)*STEP-1,10000]);
  return {config:{start:START,end:START+3*STEP,capital:70,feeRate:0,slippage:0,mode:'fixed',ambiguous:'stop-first',...patch},
    markets:[market()],datasets:{BTCUSDT:{'15m':fifteen,'4h':four}},snapshots:[]};
}
test('replays the same 4H/15M rules and fills at next 15M open rather than confirmation close',()=>{
  const report=B.run(fixture());assert.equal(report.trades.length,1);const t=report.trades[0];
  assert.equal(t.referenceEntry,101);assert.equal(t.entry,100);assert.equal(t.openedAt,START);assert.equal(t.status,'TAKE_PROFIT');
  assert.equal(t.exit,115.2);assert.ok(t.estimatedStopRisk<=2.1);assert.equal(report.stats.winRate,100);
});
test('future 4H and post-end 15M data cannot change earlier results',()=>{
  const original=fixture(),altered=fixture();
  altered.datasets.BTCUSDT['4h'].push([START,100,900,1,800,100,START+14400000-1,100]);
  altered.datasets.BTCUSDT['15m'].push([START+3*STEP,110,99999,1,500,100,START+4*STEP-1,100]);
  assert.deepEqual(B.run(original).trades,B.run(altered).trades);
});
test('same-bar stop and target touches default to conservative stop-first',()=>{
  const input=fixture();Object.assign(input.datasets.BTCUSDT['15m'].at(-3),{2:116,3:93});
  const t=B.run(input).trades[0];assert.equal(t.status,'STOP_LOSS');assert.equal(t.ambiguous,true);assert.equal(t.exit,93.9);
});
test('ambiguous review mode excludes uncertain outcomes from win rate',()=>{
  const input=fixture({ambiguous:'review'});Object.assign(input.datasets.BTCUSDT['15m'].at(-3),{2:116,3:93});
  const report=B.run(input);assert.equal(report.trades[0].status,'REVIEW');assert.equal(report.stats.closed,0);assert.equal(report.stats.winRate,null);
});
test('gap exits use the opening quote and can exceed the original risk budget',()=>{
  const input=fixture();Object.assign(input.datasets.BTCUSDT['15m'].at(-2),{1:90,2:91,3:89,4:90});
  const t=B.run(input).trades[0];assert.equal(t.status,'STOP_LOSS');assert.equal(t.exit,90);assert.ok(t.netPnl < -2.1);assert.equal(t.closedAt,START+STEP);
});
test('costs and quantity constraints are applied to historical fills',()=>{
  const result=B.run(fixture({feeRate:.0005,slippage:.0002})),t=result.trades[0];
  assert.ok(t.entry>100);assert.ok(t.exit<115.2);assert.ok(t.netPnl<t.grossPnl);assert.ok(t.estimatedStopRisk<=2.1);
});
test('unfavorable next-open entries are skipped with the actual reason retained',()=>{
  const input=fixture();Object.assign(input.datasets.BTCUSDT['15m'].at(-3),{1:104,2:105,3:103,4:104});
  const report=B.run(input);assert.equal(report.trades[0].status,'SKIPPED');assert.match(report.trades[0].reason,/1:2/);assert.equal(report.stats.closed,0);
});
test('explicit entry-price 2R variant is labeled and does not change the original fixed-target mode',()=>{
  const input=fixture({targetPolicy:'entry2r'});Object.assign(input.datasets.BTCUSDT['15m'].at(-3),{1:104,2:105,3:103,4:104});
  const report=B.run(input),trade=report.trades[0];assert.notEqual(trade.status,'SKIPPED');assert.ok(trade.target>trade.originalTarget);
  assert.ok(Math.abs(trade.target-trade.entry)/Math.abs(trade.entry-trade.stopLoss)>=2);assert.ok(report.assumptions.some(s=>s.includes('研究變體')));
});
test('open positions remain open at period end and are excluded from closed PnL',()=>{
  const input=fixture();for(const row of input.datasets.BTCUSDT['15m'].slice(-3))Object.assign(row,{1:100,2:101,3:99,4:100});
  const report=B.run(input);assert.equal(report.trades[0].status,'OPEN');assert.equal(report.stats.open,1);assert.equal(report.stats.closed,0);assert.equal(report.stats.netPnl,0);
});
test('recorded Top20 uses only prior completed snapshots and does not fill missing ranking periods',()=>{
  const input=fixture({mode:'recorded'});input.snapshots=[{finishedAt:START-1,rankedMarkets:[market()]}];
  const report=B.run(input);assert.equal(report.coverage.covered,1);assert.equal(report.coverage.windows,3);assert.equal(report.stats.closed,1);
  const future=fixture({mode:'recorded'});future.snapshots=[{finishedAt:START+1,rankedMarkets:[market()]}];
  assert.equal(B.run(future).trades.length,0);
});
test('recorded Top20 never silently falls back to current symbols',()=>{
  assert.throws(()=>B.run(fixture({mode:'recorded'})),/快照/);
  const input=fixture({mode:'recorded'});input.snapshots=[{finishedAt:START-1,rankedMarkets:[market('ETHUSDT')]}];
  assert.equal(B.run(input).trades.length,0);
});
test('rejects invalid ranges, mixed timeframes, duplicate and missing bars',()=>{
  assert.throws(()=>B.run(fixture({end:START+91*86400000})),/90/);
  const input=fixture();input.datasets.BTCUSDT['15m'].splice(5,1);assert.throws(()=>B.run(input),/缺漏/);
  assert.throws(()=>B.parse(rows('15m'),'1h'),/缺少/);
});
test('statistics and group breakdown include net PnL, cost-adjusted R and only closed samples',()=>{
  const report=B.run(fixture());const group=B.groups(report.trades,'symbol')[0];
  assert.equal(group.label,'BTCUSDT');assert.equal(group.closed,1);assert.equal(group.netPnl,report.stats.netPnl);
  assert.ok(group.averageR>2);assert.equal(B.groups(report.trades,'direction')[0].label,'LONG');
});
