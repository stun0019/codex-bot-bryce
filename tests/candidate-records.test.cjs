const test=require('node:test'),assert=require('node:assert/strict'),R=require('../site/candidate-records.js'),S=require('../site/smc-engine.js'),E=require('../site/strategy-engine.js');
const {fixture}=require('./smc-fixtures.cjs');
function c(){const f=fixture();return S.analyze(f.market,E.closedBars(f.higher,f.profile.high,f.confirmedAt),E.closedBars(f.lower.slice(0,37),f.profile.low,f.confirmedAt),f.confirmedAt,200,f.profile.id).pending;}
function storage(){const values=new Map();return {getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)};}
test('candidate records survive reload and empty/failed scans without creating trades or retaining stale sizing plans',()=>{
 const s=storage(),store=R.create(s),candidate=c();store.update([candidate],100);assert.equal(store.list().length,1);assert.equal(store.list()[0].candidate.plan,undefined);assert.equal(candidate.plan.ok,true);
 store.update([],200);const reloaded=R.create(s);assert.deepEqual(reloaded.list(),store.list());assert.equal(reloaded.list()[0].candidate.entry,candidate.entry);
 store.update([candidate],300);assert.equal(store.list().length,1);assert.equal(store.list()[0].seenAt,300);assert.equal(store.list()[0].status,undefined);
});
test('records deduplicate by strategy/profile/setup, preserve both timeframes and cap newest-first',()=>{
 const candidate=c(),other={...candidate,profileId:'1h5m'},rows=R.merge([],[candidate,other],1);assert.equal(rows.length,2);
 const many=Array.from({length:205},(_,i)=>({candidate:{...candidate,setupId:String(i)},seenAt:i})),result=R.merge(many,[]);assert.equal(result.length,200);assert.equal(result[0].seenAt,204);assert.equal(result.at(-1).seenAt,5);
});
test('bad cache cannot break scans; write failures remain visible and clearing does not alter the trading ledger',()=>{
 const store=R.create({getItem:()=>'{broken',setItem:()=>{throw Error('quota');}});assert.equal(store.list().length,0);assert.ok(store.getError());assert.equal(store.update([c()],1),false);assert.equal(store.list().length,1);assert.match(store.getError(),/quota/);
 const s=storage(),normal=R.create(s);normal.update([c()],1);normal.clear();assert.equal(R.create(s).list().length,0);
 const invalid=c();invalid.entry=NaN;assert.equal(R.merge([],[invalid]).length,0);
});
