const E=require('../site/strategy-engine.js'),B=require('../site/macd-engine.js');
const NOW=Date.UTC(2026,10,4),market={symbol:'BTCUSDT',tickSize:.01,stepSize:.001,minQty:.001,maxQty:100000,minNotional:5,quoteVolume24h:1e8};
function fixture(direction='LONG'){
 const higher=Array.from({length:300},(_,i)=>{const c=100+i*.1,at=NOW-(300-i)*14400000;return[at,c,c+.1,c-.1,c,100,at+14399999];});
 [[132,134,131,133],[133,135,132,134],[134,136,130,135],[135,138,133,137],[137,141,135,140],[140,151,138,150]].forEach((x,i)=>{const at=NOW-(6-i)*14400000;higher[294+i]=[at,...x,100,at+14399999];});
 const lower=Array.from({length:289},(_,i)=>{const at=NOW-(300-i)*900000;return[at,145,145.2,144.8,145,100,at+899999];});
 const tail=[[145,146,144,145],[145,160,144.5,150],[150,180,148,155],[155,165,147,150],[150,158,146,148],[148,149,145,147],[147,149,146,148],[148,150,148,149],[149,149.8,148,148.8],[148.8,149.5,147.5,148],[148,149.4,147.8,149],[149,149.6,148,149.3],[149.3,151,149,150.5]];
 lower.length=0;for(let i=0;i<300-tail.length;i++){const at=NOW-(300-i)*900000;lower.push([at,145,145.2,144.8,145,100,at+899999]);}tail.forEach((x,i)=>{const at=NOW-(tail.length-i)*900000;lower.push([at,...x,100,at+899999]);});
 if(direction==='SHORT')for(const rows of[higher,lower])for(const r of rows){const [o,h,l,c]=r.slice(1,5);r.splice(1,4,300-o,300-l,300-h,300-c);}
 return {higher,lower,market:{...market},asOf:NOW};
}
function analyze(f){return B.analyze(f.market,E.closedBars(f.higher,'4h',f.asOf),E.closedBars(f.lower,'15m',f.asOf),f.asOf);}
module.exports={fixture,analyze,NOW,market};
