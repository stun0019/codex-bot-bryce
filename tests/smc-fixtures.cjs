const E=require('../site/strategy-engine.js'),S=require('../site/smc-engine.js');
const CT=Date.UTC(2026,0,15,0);
const market=(symbol='BTCUSDT')=>({symbol,tickSize:.1,stepSize:.001,minQty:.001,maxQty:1000000,minNotional:5});
function fixture(profileId='4h15m',direction='SHORT'){
 const p=S.profile(profileId),hi=E.INTERVALS[p.high],lo=E.INTERVALS[p.low];
 const closes=Array.from({length:15},(_,i)=>100+Math.sin(i*1.2)).concat([100,98,96,99,102,103,92]);
 const higher=closes.map((c,i)=>{const open=i?closes[i-1]:100;return [CT-(22-i)*hi,open,Math.max(open,c)+.2,Math.min(open,c)-.2,c,100,CT-(21-i)*hi-1];});
 higher[18][1]=96.4;higher[18][3]=96.2;
 const lc=[80,81,82,81,80,82,84,83,82,84,86,85,84,86,88,87,86,88,90,89,88,90,92,91,90,93,96,99,98,97,100,103,102,101];
 const lower=lc.map((c,i)=>[CT-(34-i)*lo,c-.1,c+.2,c-.2,c,100,CT-(33-i)*lo-1]);
 lower.push([CT,101,107,100.8,102,100,CT+lo-1],[CT+lo,102,103.2,101.8,103,100,CT+2*lo-1],[CT+2*lo,103,103.1,96.3,96.5,100,CT+3*lo-1]);
 const future=[[96.5,103,96,101],[101,102,93,94],[94,95,88,89],[89,90,83,84],[84,85,78,79]];
 future.forEach(([o,h,l,c],i)=>lower.push([CT+(3+i)*lo,o,h,l,c,100,CT+(4+i)*lo-1]));
 // Supply candle full range 101.8..103.2; its midpoint is used after CHoCH.
 if(direction==='LONG')for(const rows of [higher,lower])for(const r of rows){const [o,h,l,c]=r.slice(1,5);r[1]=300-o;r[2]=300-l;r[3]=300-h;r[4]=300-c;}
 return {profile:p,market:market(),higher,lower,confirmedAt:CT+3*lo,start:CT+3*lo,end:CT+8*lo,
  input:{config:{start:CT+3*lo,end:CT+8*lo,capital:200,feeRate:0,slippage:0,mode:'fixed',ambiguous:'stop-first',profileId},markets:[market()],datasets:{BTCUSDT:{[p.high]:higher,[p.low]:lower}}}};
}
module.exports={CT,market,fixture};
