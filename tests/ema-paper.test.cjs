const test=require('node:test'),assert=require('node:assert/strict'),P=require('../site/paper-engine.js'),R=require('../site/candidate-records.js'),EMA=require('../site/ema-engine.js');
const {fixture,analyze}=require('./ema-fixtures.cjs');
function candidate(id='4h15m',direction='LONG',symbol='BTCUSDT'){const c=analyze(fixture(id,direction)).candidate;c.symbol=c.market.symbol=symbol;c.market.quoteVolume24h=symbol==='BTCUSDT'?1000000:1000;return c;}
function model(c){const m=P.createModel();m.enableAccount(200,c.confirmedAt);return m;}
test('EMA candidates reserve the common account and fill at the confirmation reference without SMC zones',()=>{
 for(const direction of ['LONG','SHORT']){const c=candidate('4h15m',direction),m=model(c);assert.equal(m.addCandidates([c],200,c.confirmedAt),1);const t=m.trades[0],q=t.reservedPlan.quantity;
  m.tick(c.symbol,c.entry+(direction==='LONG'?1:-1),c.confirmedAt+1,{aggregateId:100});assert.equal(t.status,'WAITING_PRICE');m.tick(c.symbol,c.entry,c.confirmedAt+2,{aggregateId:101});assert.equal(t.status,'OPEN');assert.equal(t.quantity,q);assert.equal(t.entry,c.entry);assert.equal(t.entryType,'LIMIT_CONFIRM');assert.equal(t.highZone,undefined);
  for(let i=0;i<3;i++)m.tick(c.symbol,c.targets[i],c.confirmedAt+3+i,{aggregateId:102+i});assert.equal(t.status,'TAKE_PROFIT');assert.equal(t.remainingQuantity,0);assert.equal(t.exitFills.length,3);assert.equal(m.stats('ema').closed,1);assert.equal(P.createModel(m.snapshot()).trades.length,1);
 }
});
test('all scanned candidates appear as paper rows even when only one fits the total 5% risk cap',()=>{
 const a=candidate(),b=candidate('1h5m','SHORT','ETHUSDT'),m=model(a);m.addCandidates([b,a],200,a.confirmedAt);assert.equal(m.trades.length,1);assert.ok(m.accountState(a.confirmedAt).usedRisk<=10);
 const records=R.merge([],[a,b],a.confirmedAt),before=JSON.stringify(m.snapshot()),plans=m.previewCandidates([a,b],200,a.confirmedAt),rows=R.paperRows(records,m.trades,{now:a.confirmedAt,currentKeys:new Set([a,b].map(P.key)),plans});
 assert.equal(rows.length,2);assert.equal(rows.filter(r=>r.status==='NOT_ENTERED').length,1);assert.ok(rows.find(r=>r.status==='NOT_ENTERED').reason);assert.equal(JSON.stringify(m.snapshot()),before);assert.equal(m.stats('ema').closed,0);
 const restored=P.createModel(m.snapshot());assert.equal(R.paperRows(records,restored.trades,{now:a.confirmedAt+1}).length,2);
});
test('candidate mirroring never reserves margin or creates duplicate positions after refresh or a failed scan',()=>{
 const c=candidate(),m=model(c),records=R.merge([],[c],c.confirmedAt);const before=JSON.stringify(m.snapshot());
 const row=R.paperRows(records,m.trades,{now:c.expiresAt+1})[0];assert.equal(row.status,'NOT_ENTERED');assert.match(row.reason,/到期/);assert.equal(row.entry,undefined);assert.equal(row.targets,undefined);assert.deepEqual(row.plannedTargets,c.targets);assert.equal(JSON.stringify(m.snapshot()),before);
 m.addCandidates([c],200,c.confirmedAt);assert.equal(R.paperRows(records,m.trades,{now:c.confirmedAt}).length,1);m.addCandidates([c],200,c.confirmedAt);assert.equal(m.trades.length,1);
});
test('EMA statistics are isolated from existing SMC and legacy records',()=>{
 const a=candidate(),m=model(a);m.addCandidates([a],200,a.confirmedAt);assert.equal(m.stats('ema').waiting,1);assert.equal(m.stats('ema:4h15m').waiting,1);assert.equal(m.stats('ema:1h5m').waiting,0);assert.equal(m.stats('previous').waiting,0);assert.equal(m.stats('all').waiting,1);assert.equal(a.strategyVersion,EMA.VERSION);
});
