(function(root){
  "use strict";
  const E=root.StrategyEngine||(typeof require==="function"?require("./strategy-engine.js"):null);
  const DEFAULTS=Object.freeze({singleRisk:.05,totalRisk:.05,directionRisk:.05,leverage:50});
  const finite=n=>typeof n==="number"&&Number.isFinite(n),epsilon=n=>1e-9*Math.max(1,Math.abs(n));
  const opened=t=>t.entry>0&&t.quantity>0;
  const remaining=t=>opened(t)&&["OPEN","REVIEW"].includes(t.status)?(finite(t.remainingQuantity)?t.remainingQuantity:t.quantity):0;
  function realized(t){
    if(!opened(t))return 0;
    if(Array.isArray(t.exitFills))return t.exitFills.reduce((sum,f)=>sum+(f.price-t.entry)*f.quantity*(t.direction==="LONG"?1:-1)-f.fee,0)-t.entryFee;
    if(["TAKE_PROFIT","STOP_LOSS"].includes(t.status))return t.netPnl;
    return -t.entryFee;
  }
  function unrealized(t){const q=remaining(t);return q?(t.lastPrice-t.entry)*q*(t.direction==="LONG"?1:-1):0;}
  function validLimits(l){return l&&[l.singleRisk,l.totalRisk,l.directionRisk,l.leverage].every(finite)&&l.singleRisk>0&&l.singleRisk<=.05&&l.totalRisk>0&&l.totalRisk<=.05&&l.directionRisk>0&&l.directionRisk<=.05&&l.leverage>=1&&l.leverage<=50;}
  function create(trades,initialCapital,at,limits=DEFAULTS){
    if(!(initialCapital>0)||!finite(initialCapital)||!finite(at)||at<=0||!validLimits(limits))throw new Error("共用帳戶設定無效");
    const baselines=Object.fromEntries(trades.map(t=>[t.id,realized(t)])),startingEquity=initialCapital+trades.reduce((sum,t)=>sum+unrealized(t),0);
    if(!finite(startingEquity))throw new Error("既有持倉淨值無法確認");
    return {version:1,id:"shared-"+at,startedAt:at,initialCapital,startingEquity,limits:{...limits},baselines};
  }
  function validate(account,trades){
    if(!account||account.version!==1||typeof account.id!=="string"||!finite(account.startedAt)||account.startedAt<=0||!(account.initialCapital>0)||!finite(account.initialCapital)||!finite(account.startingEquity)||!validLimits(account.limits)||!account.baselines||Array.isArray(account.baselines)||typeof account.baselines!=="object")throw new Error("共用帳戶紀錄無效，已停止新增");
    const ids=new Set(trades.map(t=>t.id));if(Object.entries(account.baselines).some(([id,value])=>!ids.has(id)||!finite(value)))throw new Error("共用帳戶期初基準無效");
    return JSON.parse(JSON.stringify(account));
  }
  function metrics(trades,account,at=Date.now(),excludeId=null){
    let balance=account.initialCapital,unrealizedPnl=0,positionMargin=0,orderMargin=0,feeReserve=0,usedRisk=0,notional=0,openCount=0,pendingCount=0;
    const directions={LONG:{risk:0,notional:0},SHORT:{risk:0,notional:0}},uncertain=[];
    for(const t of trades){
      balance+=realized(t)-(account.baselines[t.id]??0);unrealizedPnl+=unrealized(t);
      if(t.id===excludeId)continue;
      let risk=0,nom=0;
      if(t.status==="WAITING_PRICE"&&t.reservedPlan){const p=t.reservedPlan;risk=p.risk;nom=p.notional;orderMargin+=p.initialMargin;feeReserve+=p.feeReserve;pendingCount++;}
      const q=remaining(t);
      if(q){
        const long=t.direction==="LONG",mark=Number(t.lastPrice),stop=E.quantize((t.targetMode==="FIB"&&t.exitGuard?t.exitGuard.price:t.stopLoss)*(long?1-t.slippage:1+t.slippage),t.tickSize,long?"floor":"ceil");
        if(!(mark>0)||!finite(mark)||!(stop>0)){uncertain.push(t.symbol+" 價格無效");continue;}
        nom=q*Math.max(t.entry,mark);const exitFee=q*Math.max(t.entry,mark,stop)*t.feeRate;
        risk=t.targetMode==="FIB"?Math.max(0,q*(t.entry-stop)*(long?1:-1)+q*stop*t.feeRate):q*Math.abs(t.entry-stop)+q*stop*t.feeRate;positionMargin+=nom/account.limits.leverage;feeReserve+=exitFee;openCount++;
        const verifiedAt=Math.max(t.lastQuoteAt||0,t.recovery?.lastCheckedAt||0,t.checkpoint?.at||0);
        if(t.status==="REVIEW"||t.recovery?.pending||at-verifiedAt>30000)uncertain.push(t.symbol+" 持倉行情待核對");
      }
      usedRisk+=risk;notional+=nom;if(directions[t.direction]){directions[t.direction].risk+=risk;directions[t.direction].notional+=nom;}
    }
    const equity=balance+unrealizedPnl,invalidFinancials=![balance,equity,usedRisk,notional,positionMargin,orderMargin,feeReserve].every(finite),riskCapital=invalidFinancials?0:Math.max(0,Math.min(balance,equity));
    const rawAvailable=riskCapital-positionMargin-orderMargin-feeReserve,totalLimit=riskCapital*account.limits.totalRisk,directionLimit=riskCapital*account.limits.directionRisk;
    const breach=usedRisk>totalLimit+epsilon(totalLimit)||Object.values(directions).some(d=>d.risk>directionLimit+epsilon(directionLimit))||rawAvailable< -epsilon(riskCapital)||notional>riskCapital*account.limits.leverage+epsilon(riskCapital);
    return {accountId:account.id,initialCapital:account.initialCapital,startedAt:account.startedAt,startingEquity:account.startingEquity,balance,equity,unrealizedPnl,periodPnl:equity-account.startingEquity,
      returnPct:account.startingEquity>0?(equity/account.startingEquity-1)*100:null,riskCapital,positionMargin,orderMargin,feeReserve,rawAvailable,availableMargin:Math.max(0,rawAvailable),
      usedRisk,riskPct:riskCapital>0?usedRisk/riskCapital*100:null,totalLimit,directionLimit,notional,directions,openCount,pendingCount,limits:{...account.limits},breach,
      uncertain,blockedReason:invalidFinancials?"帳戶數值無效，暫停新增並保留紀錄":uncertain.length?"既有持倉待核對，暫停預留與進場":riskCapital<=0?"帳戶淨值不足":breach?"共用帳戶超限，暫停新增並取消待成交計畫":""};
  }
  function plan(candidate,settings,state){
    if(state.blockedReason)return {ok:false,reason:state.blockedReason};
    const single=state.riskCapital*state.limits.singleRisk,total=Math.max(0,state.totalLimit-state.usedRisk),direction=Math.max(0,state.directionLimit-state.directions[candidate.direction].risk);
    const budget=Math.min(single,total,direction),settingsOptions={...settings,riskFraction:state.limits.singleRisk,budget,leverage:state.limits.leverage,partialExit:!!candidate.partialExit};
    if(budget<=epsilon(state.riskCapital))return {ok:false,reason:total<=direction?"共用帳戶總停損風險額度不足":"同方向停損風險額度不足"};
    if(state.availableMargin<=epsilon(state.riskCapital))return {ok:false,reason:"共用帳戶可用保證金不足"};
    let result=E.position(candidate,candidate.market,state.riskCapital,settingsOptions);if(!result.ok)return result;
    const marginCap=result.quantity*state.availableMargin/result.marginReserve,notionalCap=Math.max(0,state.riskCapital*state.limits.leverage-state.notional)/result.entry;
    if(result.quantity>Math.min(marginCap,notionalCap)){
      result=E.position(candidate,candidate.market,state.riskCapital,{...settingsOptions,maxQuantity:Math.min(marginCap,notionalCap)});
      if(!result.ok)return {...result,reason:"可用保證金／名目部位額度不足："+result.reason};
    }
    return {...result,accountId:state.accountId,adjusted:budget<single-epsilon(single)||result.marginReserve>=state.availableMargin-epsilon(state.availableMargin)};
  }
  function canOpen(plan,state,direction,mark){
    if(state.blockedReason)return state.blockedReason;
    const balance=state.balance-plan.entryFee,equity=state.equity-plan.entryFee+(mark-plan.entry)*plan.quantity*(direction==="LONG"?1:-1),base=Math.max(0,Math.min(balance,equity));
    if(plan.risk>state.riskCapital*state.limits.singleRisk+epsilon(state.riskCapital))return "成交前單筆風險重新核驗未通過";
    const risk=plan.risk-plan.entryFee,total=state.usedRisk+risk,side=state.directions[direction].risk+risk;
    if(total>base*state.limits.totalRisk+epsilon(base)||side>base*state.limits.directionRisk+epsilon(base))return "成交前總風險／同方向風險重新核驗未通過";
    const nom=plan.quantity*Math.max(plan.entry,mark),exitReserve=plan.quantity*Math.max(plan.entry,mark,plan.stopFill)*plan.feeRate;
    if(state.positionMargin+state.orderMargin+state.feeReserve+nom/state.limits.leverage+exitReserve>base+epsilon(base)||state.notional+nom>base*state.limits.leverage+epsilon(base))return "成交前可用保證金重新核驗未通過";
    return "";
  }
  const api={DEFAULTS,create,validate,metrics,plan,canOpen,remaining,realized};
  if(typeof module!=="undefined"&&module.exports)module.exports=api;root.AccountRisk=api;
})(typeof self!=="undefined"?self:globalThis);
