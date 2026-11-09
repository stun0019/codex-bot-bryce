(function(root){
  'use strict';
  const E=root.StrategyEngine||(typeof require==='function'?require('./strategy-engine.js'):null);
  const NO_EXPIRY = Number.MAX_SAFE_INTEGER;
  const VERSION='macd-ob-fib-0715-v1',FRACTIONS=Object.freeze([.3,.2,.2,.3]),LEVELS=Object.freeze([0,-.27,-.618,-1]);
  const finite=Number.isFinite,near=(a,b)=>finite(a)&&finite(b)&&Math.abs(a-b)<=1e-8*Math.max(1,Math.abs(a),Math.abs(b));
  const midnight=at=>Math.floor((at+28800000)/86400000+1)*86400000-28800000;
  function check(b,previous=null){return b&&[b.openTime,b.closeTime,b.open,b.high,b.low,b.close,b.volume].every(finite)&&b.openTime%900000===0&&b.closeTime===b.openTime+899999&&b.low>0&&b.low<=Math.min(b.open,b.close)&&b.high>=Math.max(b.open,b.close)&&b.volume>=0&&(!previous||b.openTime===previous.openTime+900000);}
  function pivot(p,side){if(!p||p.side!==side||!Array.isArray(p.bars)||p.bars.length!==5)return false;for(let i=0;i<5;i++)if(!check(p.bars[i],p.bars[i-1]))return false;const b=p.bars[2];return p.openTime===b.openTime&&p.confirmedAt===p.bars[4].closeTime+1&&p.price===(side==='HIGH'?b.high:b.low)&&[0,1,3,4].every(i=>side==='HIGH'?p.bars[i].high<b.high:p.bars[i].low>b.low);}
  function prices(setup,direction,tick){const long=direction==='LONG',ob=setup.ob,endpoint=setup.endpoint.price,anchor=(setup.anchorMode==='WAVE_ORIGIN'||setup.anchorMode==='WAVE_FIB_LIMIT')?setup.fibOrigin.price:setup.anchorMode==='STRUCTURE'?setup.stopStructure.price:long?ob.low:ob.high,span=long?endpoint-anchor:anchor-endpoint,rawFib=long?endpoint-.715*span:endpoint+.715*span,inside=rawFib>=ob.low&&rawFib<=ob.high,direct=setup.anchorMode==='WAVE_FIB_LIMIT',useFib=setup.entryMode!=='OB_NEAR'&&(direct||inside),rawEntry=useFib?rawFib:long?ob.high:ob.low;
    const entry=E.quantize(rawEntry,tick,direct&&useFib?'round':long?'floor':'ceil'),stopLoss=E.quantize((direct&&setup.stopMode==='WAVE_ORIGIN'?anchor:setup.stopStructure.price)+(long?-tick:tick),tick,long?'floor':'ceil'),targets=LEVELS.map(level=>E.quantize(endpoint+(long?-1:1)*level*span,tick,long?'floor':'ceil'));
    return{entry,stopLoss,target:targets[0],targets,fibEntry:rawFib,entryLocation:useFib?'FIB_0715':'OB_NEAR',range:span};
  }
  function planAt(c){const p=prices(c.fibSetup,c.direction,c.tickSize);return{entry:p.entry,stopLoss:p.stopLoss,target:p.target,targets:p.targets};}
  function valid(c){try{
    const f=c.fibSetup,long=c.direction==='LONG',entryType=c.entryType,p=prices(f,c.direction,c.tickSize),source=f.readyTrend;
    if(c.strategyVersion!==VERSION||c.profileId!=='4h15m'||!['LONG','SHORT'].includes(c.direction)||entryType!=='LIMIT'||c.targetMode!=='FIB'||c.targetCount!==4||c.partialExit!==true||c.riskFraction!==.05||!Array.isArray(c.exitFractions)||c.exitFractions.some((x,i)=>x!==FRACTIONS[i])||c.exitFractions.length!==4||!/^[A-Z0-9]+USDT$/.test(c.symbol)||c.market?.symbol!==c.symbol||!(c.tickSize>0)||!(c.market.stepSize>0))return false;
    if(f.entryMode!==undefined&&(f.entryMode!=='OB_NEAR'||f.anchorMode!=='WAVE_FIB_LIMIT'))return false;
    if(!check(f.bos,f.previous)||!check(f.ob)||!pivot(f.broken,long?'HIGH':'LOW')||f.broken.confirmedAt>f.bos.openTime||!pivot(f.endpoint,long?'HIGH':'LOW')||!pivot(f.stopStructure,long?'LOW':'HIGH'))return false;
    if(f.anchorMode==='WAVE_ORIGIN'||f.anchorMode==='WAVE_FIB_LIMIT'){
      const origin=f.fibOrigin;
      if(!pivot(origin,long?'LOW':'HIGH')||origin.openTime<=f.broken.openTime||
        origin.openTime>=f.bos.openTime||origin.confirmedAt>f.endpoint.confirmedAt)return false;
    }
    if(f.endpoint.openTime<f.bos.openTime||Math.max(f.endpoint.confirmedAt,source?.at)!==c.confirmedAt||f.stopStructure.openTime>=f.bos.openTime||f.stopStructure.confirmedAt>c.confirmedAt||f.ob.openTime>=f.bos.openTime||(c.expiresAt!==NO_EXPIRY&&c.expiresAt!==Math.min(f.bos.closeTime+1+21600000,midnight(c.confirmedAt)))||c.expiresAt<=c.confirmedAt)return false;
    if(!(long?f.ob.close<f.ob.open&&f.bos.close>f.bos.open&&f.previous.close<=f.broken.price&&f.bos.close>f.broken.price:f.ob.close>f.ob.open&&f.bos.close<f.bos.open&&f.previous.close>=f.broken.price&&f.bos.close<f.broken.price))return false;
    if(!Array.isArray(f.leg)||!f.leg.length||f.leg[0].openTime!==f.ob.openTime||f.leg.at(-1).openTime!==f.bos.openTime)return false;
    for(let i=0;i<f.leg.length;i++){const b=f.leg[i];if(!check(b,f.leg[i-1])||(i>0&&i<f.leg.length-1&&(long?b.close<b.open:b.close>b.open)))return false;}
    if(!Array.isArray(f.afterBos)||!f.afterBos.length||f.afterBos.at(-1).closeTime+1!==f.endpoint.confirmedAt)return false;
    let previous=f.bos;for(const b of f.afterBos){if(!check(b,previous)||(long?b.low<=f.ob.low:b.high>=f.ob.high))return false;previous=b;}
    const endpointExtreme=long?Math.max(f.bos.high,...f.afterBos.filter(b=>b.openTime<=f.endpoint.openTime).map(b=>b.high)):Math.min(f.bos.low,...f.afterBos.filter(b=>b.openTime<=f.endpoint.openTime).map(b=>b.low));
    if(endpointExtreme!==f.endpoint.price||f.afterBos.filter(b=>b.openTime>f.endpoint.openTime).some(b=>long?b.low<=p.entry:b.high>=p.entry))return false;
    for(const m of [f.bosTrend,source])if(!m||![m.dif,m.signal,m.at].every(finite))return false;
    if(source.direction!==c.direction||!(long?source.dif>0:source.dif<0))return false;
    if(f.bosTrend.at>f.bos.closeTime+1||source.at>c.confirmedAt||f.bosTrend.at!==Math.floor((f.bos.closeTime+1)/14400000)*14400000||source.at!==Math.floor(c.confirmedAt/14400000)*14400000)return false;
    const entry=c.referenceEntry??c.entry,targets=c.plannedTargets||c.targets;
    if(!(p.range>0)||(f.anchorMode!=='WAVE_FIB_LIMIT'&&(p.entry<f.ob.low||p.entry>f.ob.high))||entry!==p.entry||c.stopLoss!==p.stopLoss||c.target!==p.target||!Array.isArray(targets)||targets.length!==4||targets.some((x,i)=>x!==p.targets[i])||targets.some(x=>!finite(x)||x<=0)||!(long?p.stopLoss<p.entry&&p.target>p.entry:p.stopLoss>p.entry&&p.target<p.entry))return false;
    return true;
  }catch{return false;}}
  function deadline(t){return Math.min(t.openedAt+43200000,midnight(t.openedAt));}
  function validTrade(t){try{
    if(!valid(t))return false;if(!(t.entry>0))return !t.exitGuard;
    if(t.entry!==(t.referenceEntry??t.entry)||!near(t.entryFee,t.entry*t.quantity*t.feeRate)||t.exitGuard||t.exitLegs?.length!==4||!Array.isArray(t.exitFills)||!finite(t.remainingQuantity)||t.remainingQuantity<0||t.remainingQuantity>t.quantity)return false;
    const quantities=E.partialQuantities(t.quantity,t.market.stepSize,FRACTIONS);if(quantities.length!==4||quantities.some(q=>!(q>0)))return false;
    for(let i=0;i<4;i++){const leg=t.exitLegs[i];if(leg.label!=='TP'+(i+1)||leg.price!==t.plannedTargets[i]||leg.quantity!==quantities[i]||!['PENDING','FILLED','CANCELLED'].includes(leg.status))return false;}
    const labels=new Set();for(const f of t.exitFills){if(!/^TP[1-4]$|^STOP$|^TIME_12H$|^DAY_FLAT$/.test(f.label)||labels.has(f.label)||!(f.quantity>0)||!finite(f.at)||!near(f.fee,f.price*f.quantity*t.feeRate))return false;labels.add(f.label);if(/^TP/.test(f.label)){const i=Number(f.label.slice(2))-1;if(f.quantity!==quantities[i]||f.price!==t.plannedTargets[i]||t.exitLegs[i].status!=='FILLED')return false;}}
    const funding=t.fundingFills||[];if(!Array.isArray(funding)||new Set(funding.map(f=>f.at)).size!==funding.length)return false;
    for(const f of funding){const quantity=t.quantity-t.exitFills.filter(x=>x.at<f.at).reduce((sum,x)=>sum+x.quantity,0);if(![f.at,f.rate,f.mark,f.amount,f.quantity].every(finite)||f.at<=t.openedAt||t.closedAt&&f.at>t.closedAt||!(f.mark>0)||!near(f.quantity,quantity)||!near(f.amount,f.mark*quantity*f.rate*(t.direction==='LONG'?1:-1)))return false;}
    if(!near(t.fundingPaid||0,funding.reduce((sum,f)=>sum+f.amount,0)))return false;
    const gross=t.exitFills.reduce((sum,f)=>sum+(f.price-t.entry)*f.quantity*(t.direction==='LONG'?1:-1),0),fees=t.exitFills.reduce((sum,f)=>sum+f.fee,0),out=t.exitFills.reduce((sum,f)=>sum+f.quantity,0);
    if(!near(gross,t.realizedGross)||!near(fees,t.realizedExitFees)||!near(out+t.remainingQuantity,t.quantity))return false;
    if(['TAKE_PROFIT','STOP_LOSS','TIME_EXIT'].includes(t.status)&&(!near(t.netPnl,gross-t.entryFee-fees-(t.fundingPaid||0))||t.remainingQuantity!==0||t.exitLegs.some(l=>l.status==='PENDING')))return false;
    return true;
  }catch{return false;}}
  const api={VERSION,NO_EXPIRY,FRACTIONS,LEVELS,prices,planAt,valid,validTrade,deadline,midnight,isFib:t=>t?.strategyVersion===VERSION};if(typeof module!=='undefined'&&module.exports)module.exports=api;root.FibEntry=api;
})(typeof window!=='undefined'?window:globalThis);
