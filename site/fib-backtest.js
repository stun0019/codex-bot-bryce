(function(root){
  "use strict";
  const E=root.StrategyEngine||(typeof require==="function"?require("./strategy-engine.js"):null);
  const F=root.FibEngine||(typeof require==="function"?require("./fib-engine.js"):null);
  const P=root.PaperEngine||(typeof require==="function"?require("./paper-engine.js"):null);
  const T=root.TargetEngine||(typeof require==="function"?require("./target-engine.js"):null);
  const copy=x=>JSON.parse(JSON.stringify(x)),STEP=300000;
  function bars(rows,interval){return rows.length?E.closedBars(rows,interval,Number(rows.at(-1)[6])+1):[];}
  function signals(market,series,start,end){
    const events=[];
    for(const p of Object.values(F.PROFILES)){
      const high=bars(series[p.high]||[],p.high),low=bars(series[p.low]||[],p.low).filter(b=>b.openTime>=start-499*E.INTERVALS[p.low]&&b.closeTime<end);
      const analyzer=F.createAnalyzer(p.id);let hi=0,previous=null,started=false;
      for(const bar of low){
        while(hi<high.length&&high[hi].closeTime<=bar.closeTime)analyzer.pushHigh(high[hi++]);
        if(!hi)continue;
        const result=analyzer.pushLow(bar,market),at=bar.closeTime+1,c=result.pending,id=c?P.key(c):null;
        if(at>=start&&at<end&&(!started||id!==previous)){if(c&&!F.valid(c))throw Error("回測產生無效Fib候選");events.push({at,symbol:market.symbol,profileId:p.id,candidate:c});started=true;}
        previous=id;
      }
    }
    return events.sort((a,b)=>a.at-b.at);
  }
  // A bar has two possible extremum orders. Replay both and retain the lower
  // marked liquidation value; never infer a unique tick path from OHLC.
  function replay(model,trade,bar,highFirst){
    const t=copy(trade),points=highFirst?[bar.open,bar.high,bar.low,bar.close]:[bar.open,bar.low,bar.high,bar.close];let clock=bar.openTime;
    function observe(price){
      t.lastPrice=price;t.lastQuoteAt=++clock;
      if(t.status==="WAITING_PRICE")model.tryLimitFill(t,price,clock);
      if(t.status==="OPEN"){T.quote(t,price,clock);model.executeSmc(t,price,clock,"ohlc");}
    }
    observe(points[0]);
    for(let i=1;i<points.length;i++){
      const from=points[i-1],to=points[i],up=to>from;
      const levels=t.status==="WAITING_PRICE"?[t.referenceEntry,t.stopLoss,t.target]:t.status==="OPEN"?[t.stopLoss,t.exitGuard?.price,...t.plannedTargets]:[];
      const crossed=[...new Set(levels.filter(Number.isFinite).filter(v=>up?v>from&&v<to:v<from&&v>to))].sort((a,b)=>up?a-b:b-a);
      for(const price of [...crossed,to])observe(price);
    }
    t.lastPrice=bar.close;t.lastQuoteAt=bar.closeTime+1;
    if(P.CLOSED.has(t.status))t.closedAt=bar.closeTime+1;
    if(t.openedAt&&!trade.openedAt)t.openedAt=bar.openTime;
    const score=P.CLOSED.has(t.status)?t.netPnl:t.status==="OPEN"?model.netAt(t,bar.close).net:0;
    return {trade:t,score};
  }
  function executeBar(model,trade,bar){
    const a=replay(model,trade,bar,true),b=replay(model,trade,bar,false);
    const signature=x=>JSON.stringify([x.trade.status,x.trade.remainingQuantity,x.trade.exitGuard?.label,x.trade.exitFills?.map(f=>[f.label,f.quantity,f.price])]);
    const ambiguous=signature(a)!==signature(b),chosen=a.score<=b.score?a:b;
    Object.assign(trade,chosen.trade);if(ambiguous)trade.ambiguousBars=(trade.ambiguousBars||0)+1;
    return ambiguous;
  }
  function run({markets,datasets,events,start,end,capital=200,feeRate=.0005,slippage=.0002}){
    if(!Number.isFinite(start)||!Number.isFinite(end)||start%STEP||end%STEP||end<=start)throw Error("回測期間無效");
    const model=P.createModel({version:1,trades:[],settings:{enabled:true,feeRate,slippage}});model.enableAccount(capital,start);
    const schedules=(events||markets.flatMap(m=>signals(m,datasets[m.symbol],start,end))).sort((a,b)=>a.at-b.at);
    const execution=new Map(),coverage=[];let cursor=0,ambiguousBars=0,peak=capital,maxDrawdown=0,maxDrawdownPct=0;
    for(const market of markets){
      const rows=bars(datasets[market.symbol]?.['5m']||[],'5m').filter(b=>b.openTime>=start&&b.closeTime<end);
      execution.set(market.symbol,new Map(rows.map(b=>[b.openTime,b])));
      coverage.push({symbol:market.symbol,bars:rows.length,expected:(end-start)/STEP,percent:rows.length/((end-start)/STEP)*100,firstAt:rows[0]?.openTime??null,lastAt:rows.at(-1)?.closeTime??null});
    }
    const pending=new Map(),curve=[{at:start,equity:capital}],blocked=new Map();
    for(let at=start;at<end;at+=STEP){
      // Only the current opening prices are known when reserving account risk.
      for(const t of model.trades.filter(t=>t.status==="OPEN")){
        const bar=execution.get(t.symbol)?.get(at);
        if(bar){t.lastPrice=bar.open;t.lastQuoteAt=at;}
        else{T.interrupt(t,"歷史執行行情缺漏",at);t.status="REVIEW";t.reason="歷史執行行情缺漏";}
      }
      while(cursor<schedules.length&&schedules[cursor].at<=at){
        const event=schedules[cursor++],k=event.symbol+":"+event.profileId;
        if(event.at<start)continue;
        for(const t of model.trades)if(t.symbol===event.symbol&&t.profileId===event.profileId&&t.status==="WAITING_PRICE"&&(!event.candidate||t.id!==P.key(event.candidate)))model.cancelOrder(t,"已收盤結構失效或回測",at);
        if(event.candidate)pending.set(k,event.candidate);else pending.delete(k);
      }
      for(const t of model.trades)if(t.status==="WAITING_PRICE"&&at>=t.expiresAt)model.cancelOrder(t,"限價計畫到期",at);
      const available=[...pending.values()].filter(c=>c.expiresAt>at&&execution.get(c.symbol)?.has(at));
      const previews=model.previewCandidates(available,capital,at);for(const c of available)if(!model.trades.some(t=>t.id===P.key(c))&&!previews.get(P.key(c))?.ok)blocked.set(P.key(c),previews.get(P.key(c))?.reason||"額度不足");
      model.addCandidates(available,capital,at);
      for(const t of model.trades.filter(t=>t.status==="WAITING_PRICE"||t.status==="OPEN")){
        const bar=execution.get(t.symbol)?.get(at);if(bar&&executeBar(model,t,bar))ambiguousBars++;
      }
      const state=model.accountState(at+STEP);peak=Math.max(peak,state.equity);maxDrawdown=Math.max(maxDrawdown,peak-state.equity);maxDrawdownPct=Math.max(maxDrawdownPct,peak>0?(peak-state.equity)/peak*100:0);
      if((at+STEP-start)%3600000===0||at+STEP===end)curve.push({at:at+STEP,equity:state.equity});
    }
    return {version:1,strategyVersion:F.VERSION,start,end,capital,feeRate,slippage,account:model.accountState(end),accountRecord:model.accountSnapshot(),stats:model.stats("fib"),profiles:Object.fromEntries(Object.keys(F.PROFILES).map(id=>[id,model.stats("fib:"+id)])),
      trades:model.trades,curve,maxDrawdown,maxDrawdownPct,ambiguousBars,blockedCandidates:[...blocked.keys()].filter(id=>!model.trades.some(t=>t.id===id)).length,blockedReasons:[...new Set([...blocked].filter(([id])=>!model.trades.some(t=>t.id===id)).map(([,reason])=>reason))],coverage,signals:schedules.filter(e=>e.candidate).length,
      assumptions:["每季獨立200 USDT；兩套週期共用帳戶，單筆／總／同向風險均最多5%，名目上限50x。","訊號只使用已收盤的4H＋15M或1H＋5M；5M OHLC僅供共同帳戶成交路徑重播。","每5分鐘以當時已知訊號預留；新釋放額度最早下一個5分鐘使用。","每根執行K重播開高低收及開低高收兩條路徑，取較低期末淨清算價值；存在順序歧義的K另計。非逐筆成交回測。","進場以Fib 0.715限價估算；出場含單邊手續費0.05%、不利滑價0.02%；跳空按開盤報價處理。","TP分批20%／30%／30%／剩餘20%；達TP後回撤該TP出清剩餘。","季末持倉按最後收盤估值，未強制平倉，不列入已平倉勝率；未計資金費率、強平及訂單簿深度。"]};
  }
  const api={signals,replay,executeBar,run};if(typeof module!=="undefined"&&module.exports)module.exports=api;root.FibBacktest=api;
})(typeof window!=="undefined"?window:globalThis);
