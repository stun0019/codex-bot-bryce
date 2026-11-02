const Engine = require('../site/strategy-engine.js');
const NOW = Date.UTC(2026,10,2,8,1);
function rows(interval, direction = 'LONG', now = NOW, count = 80) {
  const duration = Engine.INTERVALS[interval], end = Math.floor(now/duration)*duration;
  const data = Array.from({length:count},(_,i)=>{
    const close=interval==='4h'?100+i*.2:100;
    return [end-(count-i)*duration,close-.1,close+1,close-1,close,100,end-(count-i-1)*duration-1];
  });
  if(interval==='15m') {
    const previous=data.at(-2), last=data.at(-1);
    previous[1]=100;previous[2]=101;previous[3]=94;previous[4]=95;
    last[1]=98;last[2]=102;last[3]=98;last[4]=101;
  }
  if(direction==='SHORT') for(const row of data) { const [o,h,l,c]=row.slice(1,5);row[1]=300-o;row[2]=300-l;row[3]=300-h;row[4]=300-c; }
  if(direction==='FLAT') for(const row of data) {row[1]=row[4]=100;row[2]=101;row[3]=99;}
  return data;
}
function market(symbol='BTCUSDT') { return {symbol,tickSize:.1,stepSize:.001,minQty:.001,maxQty:1000,minNotional:5}; }
function exchange(symbols=['BTCUSDT','ETHUSDT']) { return {symbols:symbols.map(symbol=>({symbol,quoteAsset:'USDT',status:'TRADING',contractType:'PERPETUAL',filters:[
  {filterType:'PRICE_FILTER',tickSize:'0.1'}, {filterType:'LOT_SIZE',stepSize:'0.001',minQty:'0.001',maxQty:'1000'},
  {filterType:'MIN_NOTIONAL',notional:'5'}]}))}; }
module.exports={NOW,rows,market,exchange};
