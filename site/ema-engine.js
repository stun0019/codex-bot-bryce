(function(root){
  "use strict";
  const E=root.StrategyEngine||(typeof require==="function"?require("./strategy-engine.js"):null);
  const VERSION="ema20-60-200-v1";
  const PROFILES=Object.freeze({"4h15m":{id:"4h15m",label:"4H＋15M",high:"4h",low:"15m"},"1h5m":{id:"1h5m",label:"1H＋5M",high:"1h",low:"5m"}});
  function ema(bars,period){
    if(!Number.isInteger(period)||period<1)throw Error("EMA週期無效");
    if(bars.length<period)return null;
    let value=bars.slice(0,period).reduce((sum,b)=>sum+b.close,0)/period;
    for(let i=period;i<bars.length;i++)value+=(bars[i].close-value)*2/(period+1);
    return value;
  }
  function trend(bars){
    if(bars.length<200)return null;
    const values={ema20:ema(bars,20),ema60:ema(bars,60),ema200:ema(bars,200),at:bars.at(-1).closeTime+1};
    return {...values,direction:values.ema20<values.ema60&&values.ema60<values.ema200?"SHORT":values.ema20>values.ema60&&values.ema60>values.ema200?"LONG":null};
  }
  function rsi(closes){
    if(closes.length<15)return null;let gain=0,loss=0;
    for(let i=1;i<=14;i++){const d=closes[i]-closes[i-1];gain+=Math.max(0,d);loss+=Math.max(0,-d);}gain/=14;loss/=14;
    for(let i=15;i<closes.length;i++){const d=closes[i]-closes[i-1];gain=(gain*13+Math.max(0,d))/14;loss=(loss*13+Math.max(0,-d))/14;}
    return loss===0?(gain===0?50:100):100-100/(1+gain/loss);
  }
  function entryFilter(bars,direction){
    const sample=bars.slice(-250),last=sample.at(-1),previous=sample.at(-2),value=rsi(sample.map(b=>b.close));
    const ratio=previous?.volume>0&&Number.isFinite(last?.volume)&&last.volume>=0?last.volume/previous.volume:null;
    return {enabled:true,rsi:value,volumeRatio:ratio,at:last?last.closeTime+1:null,matches:value!=null&&ratio!=null&&ratio>=3&&(direction==="LONG"?value<30:direction==="SHORT"&&value>70)};
  }
  function validate(bars,interval,asOf){
    const duration=E.INTERVALS[interval];
    if(!Array.isArray(bars)||!bars.length||bars.at(-1).closeTime!==Math.floor(asOf/duration)*duration-1)throw Error("EMA需要最新已收盤的"+interval+"資料");
    for(let i=0;i<bars.length;i++){const b=bars[i];if(![b.openTime,b.closeTime,b.open,b.high,b.low,b.close,b.volume].every(Number.isFinite)||b.low<=0||b.volume<0||b.high<Math.max(b.open,b.close)||b.low>Math.min(b.open,b.close)||b.openTime%duration||b.closeTime!==b.openTime+duration-1||(i&&b.openTime!==bars[i-1].openTime+duration))throw Error("EMA K線缺漏或時間框架錯誤");}
  }
  function analyze(market,higher,lower,asOf,capital=200,id="4h15m",options={}){
    const p=PROFILES[id];if(!p)throw Error("未知EMA時間框架");
    validate(higher,p.high,asOf);validate(lower,p.low,asOf);
    // Fixed maximum windows give the browser the same deterministic SMA-seeded EMA at each scan.
    const high=higher.slice(-499),low=lower.slice(-499),bias=trend(high);
    const result={candidate:null,pending:null,profileId:p.id,timeframeLabel:p.label,trend:bias,direction:bias?.direction||null,entryFilter:{enabled:false}};
    if(!bias||low.length<21)return {...result,status:"WARMUP",reason:"等待200根高週期及21根低週期已收盤K線"};
    if(!bias.direction)return {...result,status:"NO_TREND",reason:"高週期EMA20／60／200未完整排列，觀望"};
    const current=low.at(-1),previous=low.at(-2),line=ema(low,20),priorLine=ema(low.slice(0,-1),20),long=bias.direction==="LONG";
    const touches=(bar,value)=>bar.low<=value&&bar.high>=value;
    const closesBack=long?current.close>line:current.close<line;
    const sameBar=touches(current,line)&&closesBack;
    const nextBar=touches(previous,priorLine)&&(long?previous.close<=priorLine:previous.close>=priorLine)&&closesBack;
    if(!sameBar&&!nextBar)return {...result,status:"WAIT_PULLBACK",reason:p.low.toUpperCase()+"等待觸及EMA20後收盤收回趨勢方向"};
    const touched=nextBar?previous:current,tick=Number(market.tickSize);
    if(!Number.isFinite(tick)||tick<=0)throw Error("交易價格精度無效");
    const entry=E.quantize(current.close,tick,long?"floor":"ceil"),extreme=long?Math.min(touched.low,current.low):Math.max(touched.high,current.high);
    const stopLoss=Number((E.quantize(extreme,tick,long?"floor":"ceil")+(long?-tick:tick)).toFixed(Math.min(14,E.decimals(tick))));
    const targets=E.targets(entry,stopLoss,bias.direction,tick);
    if(!(stopLoss>0)||targets.some(t=>!Number.isFinite(t)||t<=0)||(long?stopLoss>=entry:stopLoss<=entry))return {...result,status:"INVALID_LEVELS",reason:"停損或目標價位無效"};
    const filter=options.rsiFilter?entryFilter(low,bias.direction):{enabled:false};
    if(filter.enabled&&!filter.matches)return {...result,entryFilter:filter,status:"FILTERED",reason:p.low.toUpperCase()+" RSI／放量條件未通過"};
    const at=current.closeTime+1,candidate={symbol:market.symbol,direction:bias.direction,strategyVersion:VERSION,strategyName:"EMA",profileId:p.id,timeframeLabel:p.label,
      setupId:p.id+":"+bias.direction+":"+at,entryType:"LIMIT_CONFIRM",partialExit:true,targetCount:4,riskFraction:.05,entry,stopLoss,target:targets[0],targets,
      tickSize:tick,stepSize:market.stepSize,confirmedAt:at,expiresAt:at+E.INTERVALS[p.low],trendAt:bias.at,emaTrend:bias,
      pullback:{ema20:line,previousEma20:priorLine,touchAt:touched.openTime,confirmedAt:at,low:Math.min(touched.low,current.low),high:Math.max(touched.high,current.high)},entryFilter:filter,market:{...market}};
    return {...result,candidate,pending:candidate,entryFilter:filter,status:"CANDIDATE",reason:"EMA排列與低週期EMA20回踩／反彈確認；等待確認收盤價限價成交"};
  }
  const api={VERSION,PROFILES,ema,trend,rsi,entryFilter,analyze,isVersion:v=>v===VERSION};
  if(typeof module!=="undefined"&&module.exports)module.exports=api;root.EmaEngine=api;
})(typeof window!=="undefined"?window:globalThis);
