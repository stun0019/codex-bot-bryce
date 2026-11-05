const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const F=require('../site/fib-engine.js'),P=require('../site/paper-engine.js'),A=require('../site/account-risk.js');
test('all three quarter reports use current Fib rules and reproduce shared-account equity and target statistics',()=>{
 let previous=null;
 for(let q=1;q<=3;q++){
  const r=JSON.parse(fs.readFileSync(path.join(__dirname,'../site/research/fib-2026-q'+q+'.json'),'utf8'));assert.equal(r.strategyVersion,F.VERSION);assert.equal(r.quarter,'2026 Q'+q);assert.equal(r.capital,200);if(previous)assert.equal(r.start,previous);previous=r.end;
  const m=P.createModel({version:1,trades:r.trades,settings:{enabled:true,feeRate:r.feeRate,slippage:r.slippage},account:r.accountRecord}),state=m.accountState(r.end),stats=m.stats('fib');
  assert.equal(state.equity,r.account.equity);assert.equal(state.returnPct,r.account.returnPct);assert.equal(stats.winRate,r.stats.winRate);assert.deepEqual(stats.targets,r.stats.targets);assert.equal(stats.closed,stats.wins+stats.losses);
  assert.equal(r.profiles['4h15m'].closed+r.profiles['1h5m'].closed,stats.closed);assert.ok(r.maxDrawdownPct>=0);assert.match(r.scope,/非.*歷史Top20/);
  for(const t of r.trades){assert.equal(t.strategyVersion,F.VERSION);assert.equal(t.exitFractions.length,4);assert.ok(t.detectedAt>=r.start&&t.detectedAt<r.end);assert.ok(!t.openedAt||t.openedAt>=t.detectedAt);assert.ok(!t.quantity||t.estimatedStopRisk<=t.budget+1e-7);}
  assert.ok(r.coverage.every(c=>c.percent>=0&&c.percent<=100));assert.ok(Number.isFinite(A.metrics(r.trades,r.accountRecord,r.end).equity));
 }
});
