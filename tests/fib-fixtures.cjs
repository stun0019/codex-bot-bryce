const E=require('../site/strategy-engine.js'),F=require('../site/fib-engine.js');
const NOW=Date.UTC(2026,10,4),market={symbol:'BTCUSDT',tickSize:.01,stepSize:.001,minQty:.001,maxQty:100000,minNotional:5,quoteVolume24h:1000000};
function fixture(id='4h15m',direction='SHORT'){
 const profile=F.PROFILES[id],lo=E.INTERVALS[profile.low],hi=E.INTERVALS[profile.high];
 const higher=Array.from({length:400},(_,i)=>{const c=150-i*.1,at=NOW-(400-i)*hi;return[at,c+.05,c+.2,c-.2,c,100,at+hi-1];});
 const highTail=[[108,108.7,107,108],[108,109,107.5,108.3],[108,110,107.5,109],[109,109.5,107.7,108],[108,108.5,106.8,107],[107,109.8,100,103.5]];
 highTail.forEach(([o,h,l,c],i)=>{const at=NOW-(6-i)*hi;higher[394+i]=[at,o,h,l,c,100,at+hi-1];});
 const lower=Array.from({length:386},(_,i)=>{const at=NOW-(400-i)*lo;return[at,105,105.2,104.8,105,100,at+lo-1];});
 const tail=[[105,106,104.5,105.5],[105.5,106.5,104.2,105.8],[105.8,106,103,104],[104,107,104,106],[106,108,105,107],[107,109.4,106.5,109.2],[109.2,109.8,108,109.4],[109.4,109.6,107,108],[108,108.5,105,106],[106,106.5,101.5,102],[102,103,100,101],[101,103,100.5,102],[102,104,101,103],[103,104.5,102,103.5]];
 tail.forEach(([o,h,l,c],i)=>{const at=NOW-(14-i)*lo;lower.push([at,o,h,l,c,100,at+lo-1]);});
 if(direction==='LONG')for(const rows of [higher,lower])for(const r of rows){const[o,h,l,c]=r.slice(1,5);r[1]=210-o;r[2]=210-l;r[3]=210-h;r[4]=210-c;}
 return{profile,higher,lower,market:{...market},asOf:NOW};
}
function analyze(f,count=f.lower.length,options={}){const asOf=f.lower[count-1][6]+1;return F.analyze(f.market,E.closedBars(f.higher,f.profile.high,asOf),E.closedBars(f.lower.slice(0,count),f.profile.low,asOf),asOf,200,f.profile.id,options);}
function candidate(id='4h15m',direction='SHORT'){return analyze(fixture(id,direction)).pending;}
module.exports={fixture,analyze,candidate,NOW,market};
