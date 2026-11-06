(function(root){
 'use strict';
 const E=root.StrategyEngine||(typeof require==='function'?require('./strategy-engine.js'):null),VERSION='macd-smc-ob-15m-2r-v1',copy=x=>JSON.parse(JSON.stringify(x));
 const isSingle=t=>t?.strategyVersion===VERSION;
 function target(entry,stop,direction,tick){const sign=direction==='LONG'?1:-1,d=Math.abs(entry-stop);let v=E.quantize(entry+sign*2*d,tick,sign>0?'ceil':'floor');if(Math.abs(v-entry)/d<2)v=Number((v+sign*tick).toFixed(Math.min(14,E.decimals(tick))));return v;}
 function planAt(c,entry){return{entry,stopLoss:c.stopLoss,target:target(entry,c.stopLoss,c.direction,c.tickSize),targets:[target(entry,c.stopLoss,c.direction,c.tickSize)]};}
 function zone(ob,tick){return{low:E.quantize(ob.low,tick,'floor'),high:E.quantize(ob.high,tick,'ceil')};}
 function valid(c){try{const f=c.smcEntry,long=c.direction==='LONG',z=zone(f.ob,c.tickSize),ref=c.referenceEntry??c.entry,prices=c.plannedTargets||c.targets,entry=E.quantize(f.confirmation.close,c.tickSize,long?'ceil':'floor'),stop=E.quantize((long?z.low:z.high)+(long?-c.tickSize:c.tickSize),c.tickSize,long?'floor':'ceil'),level=f.structure.price;
  if(!isSingle(c)||c.profileId!=='4h15m'||c.entryType!=='MARKET_NEXT'||c.targetMode!=='SINGLE'||c.partialExit!==false||c.targetCount!==1||c.riskFraction!==.05||!['LONG','SHORT'].includes(c.direction)||ref!==entry||c.stopLoss!==stop||c.confirmedAt!==f.confirmation.closeTime+1||c.expiresAt!==Math.min(f.setupAt+21600000,c.confirmedAt+900000)||c.expiresAt<=c.confirmedAt)return false;
  if(f.setupAt!==f.bos.closeTime+1||f.structure.confirmedAt>f.bos.openTime||f.swingAnchor.confirmedAt>f.bos.openTime||f.previous.closeTime+1!==f.bos.openTime||f.touch.openTime<f.setupAt||f.touch.openTime>f.confirmation.openTime||f.ob.openTime>=f.bos.openTime||f.ob.openTime<f.swingAnchor.bar.openTime)return false;
  if(!(long?f.ob.close<f.ob.open&&f.previous.close<=level&&f.bos.close>level&&f.bos.close>z.high&&f.touch.low<=z.high&&f.touch.low>stop&&f.confirmation.close>z.high&&f.confirmation.low>stop:f.ob.close>f.ob.open&&f.previous.close>=level&&f.bos.close<level&&f.bos.close<z.low&&f.touch.high>=z.low&&f.touch.high<stop&&f.confirmation.close<z.low&&f.confirmation.high<stop))return false;
  if(f.structure.side!==(long?'HIGH':'LOW')||f.swingAnchor.side!==(long?'LOW':'HIGH'))return false;
  if(!Array.isArray(f.legBars)||!f.legBars.length||f.legBars.at(-1).openTime!==f.previous.openTime||!f.legBars.some(b=>JSON.stringify(b)===JSON.stringify(f.ob))||f.legBars.some(b=>b.openTime>f.ob.openTime&&(long?b.close<b.open:b.close>b.open)))return false;
  for(const [h,l,at] of [[f.setupHigh,f.setupLow,f.setupAt],[f.highMacd,f.lowMacd,c.confirmedAt]])if(![h,l].every(m=>m?.direction===c.direction&&(long?m.dif>0&&m.signal>0:m.dif<0&&m.signal<0))||h.at>at||l.at!==at)return false;
  const expected=target(c.quantity>0?c.entry:entry,stop,c.direction,c.tickSize);return (long?stop<ref:stop>ref)&&c.target===expected&&prices?.length===1&&prices[0]===expected;
 }catch{return false;}}
 function validTrade(t){try{if(!valid(t))return false;if(!(t.entry>0))return t.exitGuard===undefined;
  const near=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=1e-8*Math.max(1,Math.abs(a),Math.abs(b)),expected=target(t.entry,t.stopLoss,t.direction,t.tickSize);
  if(t.exitGuard||t.plannedTargets?.length!==1||t.target!==expected||t.plannedTargets[0]!==expected||t.exitLegs?.length!==1||!Array.isArray(t.exitFills)||!(t.quantity>0)||!Number.isFinite(t.remainingQuantity)||t.remainingQuantity<0||t.remainingQuantity>t.quantity)return false;
  const leg=t.exitLegs[0];if(leg.label!=='TP1'||leg.price!==expected||leg.quantity!==t.quantity||!['PENDING','FILLED','CANCELLED'].includes(leg.status))return false;
  if(t.exitFills.length>1||t.exitFills.some(f=>!['STOP','TP1'].includes(f.label)||f.quantity!==t.quantity||!Number.isFinite(f.at)||!near(f.fee,f.price*f.quantity*t.feeRate)))return false;
  const gross=t.exitFills.reduce((s,f)=>s+(f.price-t.entry)*f.quantity*(t.direction==='LONG'?1:-1),0),fees=t.exitFills.reduce((s,f)=>s+f.fee,0),out=t.exitFills.reduce((s,f)=>s+f.quantity,0);
  if(!near(gross,t.realizedGross)||!near(fees,t.realizedExitFees)||!near(out+t.remainingQuantity,t.quantity))return false;
  const closed=['TAKE_PROFIT','STOP_LOSS'].includes(t.status);if(closed&&(!near(t.netPnl,gross-t.entryFee-fees)||t.remainingQuantity!==0||leg.status==='PENDING'))return false;
  if(t.status==='OPEN'&&(t.exitFills.length||leg.status!=='PENDING'))return false;
  if(leg.status==='FILLED'&&(t.exitFills[0]?.label!=='TP1'||leg.at!==t.exitFills[0].at))return false;return true;
 }catch{return false;}}
 const api={VERSION,isSingle,target,planAt,zone,valid,validTrade};if(typeof module!=='undefined'&&module.exports)module.exports=api;root.SmcEntry=api;
})(typeof window!=='undefined'?window:globalThis);
