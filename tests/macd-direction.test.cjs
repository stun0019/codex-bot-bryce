const test=require('node:test'),assert=require('node:assert/strict'),M=require('../site/macd-engine.js'),{fixture,analyze}=require('./macd-fixtures.cjs');
const bars=closes=>closes.map((close,i)=>({close,closeTime:(i+1)*14400000-1}));
test('MACD12/26/9 uses both DIF and signal zero sides, independently of histogram sign',()=>{
 const up=Array.from({length:100},(_,i)=>100+i),r=M.trend(bars(up));assert.ok(Math.abs(r.dif-7)<1e-10);assert.ok(Math.abs(r.signal-7)<1e-10);assert.equal(r.direction,'LONG');
 const down=M.trend(bars(up.map(x=>400-x)));assert.equal(down.direction,'SHORT');assert.ok(Math.abs(down.dif+7)<1e-10);
 const flat=M.trend(bars(up.map(()=>100)));assert.equal(flat.direction,null);
 const mixed=M.trend(bars([...up.slice(0,-1),.1]));assert.ok(mixed.dif<0&&mixed.signal>0);assert.equal(mixed.direction,null);
 const negativeHistogram=M.trend(bars([...up.slice(0,-1),190]));assert.ok(negativeHistogram.histogram<0);assert.equal(negativeHistogram.direction,'LONG');
 assert.equal(M.trend(bars(up.slice(0,34))),null);
});
test('opposing 15M MACD blocks an otherwise bullish 4H context',()=>{
 const f=fixture();for(const r of f.lower){const[o,h,l,c]=r.slice(1,5);r.splice(1,4,300-o,300-l,300-h,300-c);}assert.equal(analyze(f).pending,null);
});
test('both timeframe signal lines must remain on the indicated zero side',()=>{
 const c=analyze(fixture()).pending;assert.ok(c);for(const change of [x=>x.fib.highMacd.signal=0,x=>x.fib.lowMacd.signal=-1,x=>x.fib.lowMacd.dif=0]){const copy=structuredClone(c);change(copy);assert.equal(M.valid(copy),false);}
});
