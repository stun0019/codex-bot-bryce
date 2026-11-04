const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const B=require('../site/bt-engine.js'),P=require('../site/paper-engine.js'),S=require('../site/smc-engine.js'),root=path.resolve(__dirname,'../site');
test('six automatic quarterly reports match the final engine version and complete Q1/Q2/Q3 dates',()=>{
 const index=JSON.parse(fs.readFileSync(path.join(root,'research/index.json'),'utf8'));assert.equal(index.strategyVersion,S.VERSION);assert.equal(index.reports.length,6);
 const pairs=new Set();for(const row of index.reports){const r=JSON.parse(fs.readFileSync(path.join(root,row.url),'utf8'));pairs.add(r.quarter+':'+r.profileId);
  assert.equal(r.strategyVersion,S.VERSION);assert.equal(r.config.capital,200);assert.equal(r.config.profileId,row.profileId);assert.equal(r.symbols.length,20);B.validate(r.config);
  assert.ok(r.config.start>=Date.parse('2026-01-01T00:00:00+08:00'));assert.ok(r.config.end<=Date.parse('2026-10-01T00:00:00+08:00'));
  const summary=B.summarize(r.trades);assert.equal(summary.closed,r.stats.closed);assert.ok(Math.abs(summary.netPnl-r.stats.netPnl)<1e-8);assert.equal(summary.winRate,row.stats.winRate);
 }assert.equal(pairs.size,6);
});
test('every saved quarterly trade reloads with validated partial quantities, fees and four-target provenance',()=>{
 const index=JSON.parse(fs.readFileSync(path.join(root,'research/index.json'),'utf8'));
 for(const row of index.reports){const r=JSON.parse(fs.readFileSync(path.join(root,row.url),'utf8'));const m=P.createModel({version:1,settings:{enabled:true,feeRate:r.config.feeRate,slippage:r.config.slippage},trades:r.trades});
  assert.equal(m.trades.length,r.trades.length);for(const t of m.trades){assert.equal(t.profileId,row.profileId);if(t.quantity){assert.equal(t.targets.length,4);assert.ok(t.estimatedStopRisk<=10+1e-8);assert.equal(t.exitFills.some(f=>f.label==='TP4'),false);}}
 }
});
