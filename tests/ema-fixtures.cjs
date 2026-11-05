const E=require('../site/strategy-engine.js'),EMA=require('../site/ema-engine.js');
const NOW=Date.UTC(2026,10,4),market={symbol:'BTCUSDT',tickSize:.01,stepSize:.001,minQty:.001,maxQty:100000,minNotional:5,quoteVolume24h:1000000};
function fixture(id='4h15m',direction='LONG'){
 const profile=EMA.PROFILES[id];
 function series(interval){const duration=E.INTERVALS[interval],end=Math.floor(NOW/duration)*duration;return Array.from({length:400},(_,i)=>{const c=100+i*.1,at=end-(400-i)*duration;return [at,c-.02,c+.2,c-.2,c,100,at+duration-1];});}
 const higher=series(profile.high),lower=series(profile.low),last=lower.at(-1),close=last[4];last[1]=close-.1;last[2]=close+.2;last[3]=close-2;
 if(direction==='SHORT')for(const rows of [higher,lower])for(const row of rows){const [o,h,l,c]=row.slice(1,5);row[1]=300-o;row[2]=300-l;row[3]=300-h;row[4]=300-c;}
 return {profile,higher,lower,market:{...market},asOf:NOW};
}
function analyze(f,options={}){return EMA.analyze(f.market,E.closedBars(f.higher,f.profile.high,f.asOf),E.closedBars(f.lower,f.profile.low,f.asOf),f.asOf,200,f.profile.id,options);}
module.exports={fixture,analyze,NOW,market};
