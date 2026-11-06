const durations={'4h':14400000,'1h':3600000,'15m':900000,'5m':300000};
const asOf=Date.UTC(2026,10,6,4,7);
function bars(interval,{direction='UP',last=null,count=499}={}){
 const duration=durations[interval],end=Math.floor(asOf/duration)*duration;
 return Array.from({length:count},(_,i)=>{const close=last!==null&&i===count-1?last:direction==='UP'?1000+i:direction==='DOWN'?2000-i:100;return{openTime:end-(count-i)*duration,closeTime:end-(count-i-1)*duration-1,open:close,close,high:close+2+Math.sin(i*1.4),low:close-2+Math.sin(i*1.4),volume:100+i};});
}
const rows=bars=>bars.map(b=>[b.openTime,b.open,b.high,b.low,b.close,b.volume,b.closeTime]);
module.exports={asOf,bars,rows,durations};
