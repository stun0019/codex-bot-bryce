(function(){
  "use strict";
  const $=id=>document.getElementById(id),Store=window.LabStore,B=window.BacktestEngine,Charts=window.BacktestCharts;
  const data=window.BacktestData.createClient(),marketClient=window.StrategyData.createClient();
  const status=$("btStatus"),meter=$("btProgress");
  let report=null,worker=null,controller=null,selectedTrade=null,chartInterval="15m",chartShift=0,chartRequest=0,archive=[],chartRows=null;
  const money=v=>Number.isFinite(v)?v.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2}):"—";
  const signed=v=>Number.isFinite(v)?(v>0?"+":"")+money(v):"—";
  const price=v=>Number.isFinite(v)?v.toLocaleString("en-US",{maximumSignificantDigits:9}):"—";
  const date=v=>new Date(v).toLocaleString("zh-TW",{timeZone:"Asia/Taipei",hour12:false});
  const day=v=>new Date(v).toLocaleDateString("en-CA",{timeZone:"Asia/Taipei"});
  const pf=s=>s.profitFactor!=null?s.profitFactor.toFixed(2):s.grossProfit>0&&s.grossLoss===0?"∞":"—";
  const labels={WAITING_PRICE:"期末未成交",OPEN:"期末持倉",TAKE_PROFIT:"止盈",STOP_LOSS:"止損",SKIPPED:"略過",REVIEW:"不確定"};
  const titleMode=mode=>mode==="recorded"?"已保存 Top20 時段":"固定選定合約";
  function node(tag,text,className){const n=document.createElement(tag);if(text!=null)n.textContent=text;if(className)n.className=className;return n;}
  function td(text){return node("td",text);}
  function message(text,state=""){status.textContent=text;status.dataset.state=state;}
  function busy(value){for(const id of ["btRun","btUseTop","btReports"])$(id).disabled=value;$("btCancel").disabled=!value;}
  function inputs(){
    const startText=$("btStart").value,endText=$("btEnd").value;
    if(!/^\d{4}-\d{2}-\d{2}$/.test(startText)||!/^\d{4}-\d{2}-\d{2}$/.test(endText))throw new Error("請輸入完整日期");
    const start=Date.parse(startText+"T00:00:00+08:00"),end=Date.parse(endText+"T00:00:00+08:00")+86400000;
    const config={start,end,capital:Number($("btCapital").value),feeRate:Number($("btFee").value)/100,
      slippage:Number($("btSlip").value)/100,mode:$("btMode").value,ambiguous:$("btAmbiguous").value,targetPolicy:"smc",profileId:$("btProfile").value,
      startDate:startText,endDate:endText};
    B.validate(config);return config;
  }
  function fixedSymbols(){
    const names=[...new Set($("btSymbols").value.toUpperCase().split(/[\s,，、]+/).filter(Boolean).map(s=>s.replace(/[-_/]/g,"")).map(s=>s.endsWith("USDT")?s:s+"USDT"))];
    if(!names.length||names.length>20||names.some(s=>!/^[A-Z0-9]+USDT$/.test(s)))throw new Error("請選擇 1～20 個有效 USDT 合約");return names;
  }
  async function refreshReports(selected){
    const rows=(await Store.all("reports")).sort((a,b)=>b.createdAt-a.createdAt),picker=$("btReports");
    const current=selected||picker.value;picker.replaceChildren(node("option","選擇已保存的報告"));picker.firstChild.value="";
    for(const row of rows){const option=node("option",date(row.createdAt)+" · "+titleMode(row.config.mode)+" · "+(row.strategyVersion?"SMC · "+(window.SmcEngine.PROFILES[row.config.profileId]?.label||"兩套週期"):"舊策略")+" · "+row.stats.closed+" 筆平倉");option.value=row.id;picker.append(option);}
    if(rows.some(r=>r.id===current))picker.value=current;
    return rows;
  }
  function groupReport(){
    if(!report)return;const body=$("btGroupRows");body.replaceChildren();
    for(const group of B.groups(report.trades,$("btGroup").value)){
      const row=node("tr");row.append(td(group.label==="LONG"?"做多":group.label==="SHORT"?"做空":group.label),td(group.closed),
        td(group.winRate==null?"—":group.winRate.toFixed(1)+"%"),td(signed(group.averagePnl)),td(signed(group.netPnl)),td(pf(group)),...group.targets.levels.map(t=>td(t.rate==null?"—":t.rate.toFixed(1)+"% ("+t.hits+"/"+t.resolved+")")));body.append(row);
    }
  }
  function tradesReport(){
    if(!report)return;const filter=$("btTradeFilter").value,body=$("btTradeRows");body.replaceChildren();
    const all=[...report.trades].reverse().filter(t=>filter==="all"||(filter==="closed"?window.PaperEngine.CLOSED.has(t.status):t.status===filter));
    $("btTradeCount").textContent="符合篩選 "+all.length+" 筆；畫面顯示最近 200 筆，統計包含完整紀錄。";
    for(const trade of all.slice(0,200)){
      const row=node("tr"),identity=td(trade.symbol);identity.append(node("small",trade.timeframeLabel?"SMC · "+trade.timeframeLabel:"舊策略／未標示週期"));identity.append(node("small",trade.direction==="LONG"?"做多":"做空"));
      const state=td(labels[trade.status]);if(trade.status==="SKIPPED"||trade.status==="REVIEW")state.append(node("small",trade.reason));if(trade.ambiguous)state.append(node("small","同根雙觸價"));
      const pnl=td(signed(trade.netPnl));pnl.dataset.tone=trade.netPnl>0?"positive":trade.netPnl<0?"negative":"neutral";
      const chart=td(""),button=node("button","查看");button.type="button";button.addEventListener("click",()=>{selectedTrade=trade;chartInterval=window.SmcEngine.PROFILES[trade.profileId]?.low||"15m";chartShift=0;void showChart();});chart.append(button);
      const targetCell=td("");targetCell.append(window.TargetView.detail(trade));
      row.append(identity,td(date(trade.openedAt||trade.confirmedAt)),td(price(trade.entry)),td(price(trade.stopLoss)),targetCell,state,pnl,chart);body.append(row);
    }
    if(!all.length){const row=node("tr"),cell=td("此篩選下沒有交易。");cell.colSpan=8;row.append(cell);body.append(row);}
  }
  function renderReport(value){
    report=value;$("btReport").hidden=false;$("btExport").disabled=false;$("btChartPanel").hidden=true;selectedTrade=null;
    if(report.quarter)$("btTradeFilter").value="closed";
    $("btStart").value=report.config.startDate||day(report.config.start);$("btEnd").value=report.config.endDate||day(report.config.end-1);
    $("btProfile").value=report.config.profileId||"both";
    $("btMode").value=report.config.mode;$("btSymbolsLabel").hidden=report.config.mode!=="fixed";
    $("btSymbols").value=report.symbols.join(", ");$("btCapital").value=report.config.capital;
    $("btFee").value=Number((report.config.feeRate*100).toFixed(6));$("btSlip").value=Number((report.config.slippage*100).toFixed(6));
    $("btAmbiguous").value=report.config.ambiguous;$("btTargetPolicy").value=report.config.targetPolicy||"signal";
    window.TargetView.stats($("btTargets"),report.trades);
    const s=report.stats;$("btClosed").textContent=s.closed+" / "+s.open;$("btWinRate").textContent=s.winRate==null?"—":s.winRate.toFixed(1)+"%";
    $("btNet").textContent=signed(s.netPnl);$("btNet").dataset.tone=s.netPnl>=0?"positive":"negative";
    $("btDrawdown").textContent=money(s.maxDrawdown);$("btFactor").textContent=pf(s);$("btStreak").textContent=String(s.maxLossStreak);
    $("btCoverage").textContent=titleMode(report.config.mode)+" · "+(report.strategyVersion?"SMC · "+(window.SmcEngine.PROFILES[report.config.profileId]?.label||"兩套週期")+" · 30%／30%／剩餘":"舊策略：原出場規則")+"｜"+date(report.config.start)+" ～ "+date(report.config.end)+
      "｜"+report.symbols.length+" 個合約｜"+(report.config.mode==="recorded"?"排名快照覆蓋 "+report.coverage.percent.toFixed(1)+"%（"+report.coverage.covered+" / "+report.coverage.windows+" 時段）":"此結果不代表歷史成交額 Top20 策略");
    $("btSamples").textContent="平均淨損益 "+signed(s.averagePnl)+" USDT · 平均淨 R "+(s.averageR==null?"—":s.averageR.toFixed(2))+
      " · 略過 "+s.skipped+" · 不確定 "+s.review+" · 雙觸價 "+s.ambiguous+"；勝率只計已平倉、費後淨獲利筆數。";
    Charts.curve($("btCurve"),s.curve);const assumptions=$("btAssumptions");assumptions.replaceChildren();
    for(const text of [...report.assumptions,...report.warnings])assumptions.append(node("li",text));
    groupReport();tradesReport();
  }
  window.BacktestView={show:renderReport};
  async function showChart(){
    if(!selectedTrade||!report)return;const request=++chartRequest,trade=selectedTrade;
    $("btChartPanel").hidden=false;$("btChartTitle").textContent=trade.symbol+" · "+(trade.timeframeLabel||"舊策略／未標示週期")+" · "+(trade.direction==="LONG"?"做多":"做空")+" · "+labels[trade.status];
    $("btChartInfo").textContent="讀取本機行情快取…";
    try{
      const profile=window.SmcEngine.PROFILES[trade.profileId]||{high:"4h",low:"15m"};
      $("bt15m").textContent=profile.low.toUpperCase();$("bt4h").textContent=profile.high.toUpperCase();
      const key=report.refs?.[trade.symbol]?.[chartInterval];let series=key?await Store.get("series",key):null;
      if(!series&&report.strategyVersion){const duration=window.StrategyEngine.INTERVALS[chartInterval],focus=trade.openedAt||trade.confirmedAt,start=Math.floor((focus-40*duration)/duration)*duration,end=Math.floor((focus+45*duration)/duration)*duration;series=await data.range(trade.symbol,chartInterval,start,end);}
      if(request!==chartRequest)return;
      if(!series)throw new Error("本機行情快取不存在，請重新執行此回測以重建圖表");
      chartRows=series.rows;$("bt15m").setAttribute("aria-pressed",String(chartInterval===profile.low));$("bt4h").setAttribute("aria-pressed",String(chartInterval===profile.high));
      Charts.candles($("btCandles"),{rows:chartRows,interval:chartInterval,trade,shift:chartShift},$("btReadout"));
      $("btChartInfo").textContent=trade.reason+"｜TP1 基準 "+price(trade.target)+"｜參考訊號 "+date(trade.confirmedAt)+"｜數量 "+price(trade.quantity)+
        "｜模擬進場 "+price(trade.entry)+"｜模擬出場 "+price(trade.exit);
      $("btChartPanel").scrollIntoView({block:"start",behavior:"smooth"});
    }catch(error){$("btChartInfo").textContent=error.message;$("btCandles").replaceChildren();}
  }
  function compute(input,signal){
    return new Promise((resolve,reject)=>{
      if(signal.aborted){reject(new DOMException("Aborted","AbortError"));return;}
      if(!window.Worker){reject(new Error("此瀏覽器無法使用背景回測 Worker，請改用較新版本瀏覽器"));return;}
      const abort=()=>{worker?.terminate();worker=null;reject(new DOMException("Aborted","AbortError"));};
      worker=new Worker("bt-worker.js?v=smc-1");signal.addEventListener("abort",abort,{once:true});
      const finish=()=>{signal.removeEventListener("abort",abort);worker?.terminate();worker=null;};
      worker.onmessage=event=>{const response=event.data;
        if(response.type==="progress"){message("重播策略 "+response.progress.completed+" / "+response.progress.total+" · "+response.progress.symbol);meter.value=.6+.4*response.progress.completed/response.progress.total;}
        else if(response.type==="result"){finish();resolve(response.report);}else if(response.type==="error"){finish();reject(new Error(response.message));}};
      worker.onerror=()=>{finish();reject(new Error("回測 Worker 執行失敗，請重新整理後重試"));};
      worker.postMessage(input);
    });
  }
  $("btForm").addEventListener("submit",async event=>{
    event.preventDefault();if(controller)return;let config;
    try{config=inputs();}catch(error){message(error.message,"error");return;}
    controller=new AbortController();const signal=controller.signal;busy(true);meter.max=1;meter.value=0;message("確認幣安時間與回測範圍…");
    try{
      const server=await data.json("/fapi/v1/time",signal);config.end=Math.min(config.end,Math.floor(Number(server.serverTime)/300000)*300000);B.validate(config);
      let markets,snapshots=[];
      if(config.mode==="fixed"){
        const selected=fixedSymbols(),listed=await marketClient.markets(signal);markets=selected.map(symbol=>{const market=listed.find(m=>m.symbol===symbol);if(!market)throw new Error(symbol+" 不是目前可取得交易精度的 USDT 永續合約");return market;});
      }else{
        snapshots=(await Store.all("scans")).filter(s=>s.status==="COMPLETE"&&s.finishedAt<config.end&&s.finishedAt>=config.start-900000);
        if(!snapshots.length)throw new Error("此期間沒有已保存 Top20 快照；請改選固定幣種，或先累積掃描紀錄");
        const union=new Map();for(const snapshot of snapshots)for(const market of snapshot.rankedMarkets)union.set(market.symbol,market);markets=[...union.values()];
      }
      const bars=markets.length*((config.end-config.start+20*86400000)/(config.profileId==="4h15m"?900000:300000))*(config.profileId==="both"?1.34:1);
      if(markets.length>100||bars>220000)throw new Error("本機資料量過大，請縮短期間或減少合約數量");
      message("載入 "+markets.length+" 個合約歷史資料；完整批次會保存在本機快取…");
      const loaded=await data.load(markets,config,signal,p=>{message("載入行情 "+p.completed+" / "+p.total+" · "+p.symbol+" "+p.interval+(p.cached?"（本機快取）":""));meter.value=.6*p.completed/p.total;});
      const result=await compute({config,markets,datasets:loaded.datasets,snapshots},signal);
      result.id=crypto.randomUUID();result.createdAt=Date.now();result.refs=loaded.refs;
      if(signal.aborted)throw new DOMException("Aborted","AbortError");
      renderReport(result);meter.value=1;
      try{await Store.put("reports",result);await refreshReports(result.id);message("回測完成，報告與行情已保存在此瀏覽器。","live");}
      catch(error){message("回測完成，但本機報告儲存失敗："+error.message,"error");}
    }catch(error){message(error.name==="AbortError"?"已取消；完成下載的行情快取仍可在下次重用。":error.name==="QuotaExceededError"?"本機儲存空間不足，請縮短回測期間或減少幣種。":error.message,"error");}
    finally{controller=null;busy(false);}
  });
  $("btCancel").addEventListener("click",()=>controller?.abort());
  $("btUseTop").addEventListener("click",async()=>{const button=$("btUseTop");button.disabled=true;try{const rows=await marketClient.topMarkets();$("btSymbols").value=rows.map(r=>r.symbol).join(", ");$("btMode").value="fixed";$("btSymbolsLabel").hidden=false;message("已填入目前 Top20 作為固定名單；此模式不代表當時的歷史排名。");}catch(error){message(error.message,"error");}finally{button.disabled=false;}});
  $("btMode").addEventListener("change",()=>{$("btSymbolsLabel").hidden=$("btMode").value!=="fixed";});
  $("btReports").addEventListener("change",async()=>{if(!$("btReports").value)return;try{const saved=await Store.get("reports",$("btReports").value);if(!saved)throw new Error("報告不存在");renderReport(saved);message("已載入本機保存報告。","live");}catch(error){message(error.message,"error");}});
  $("btGroup").addEventListener("change",groupReport);$("btTradeFilter").addEventListener("change",tradesReport);
  for(const[button,interval]of[["bt15m","15m"],["bt4h","4h"]])$(button).addEventListener("click",()=>{chartInterval=window.SmcEngine.PROFILES[selectedTrade?.profileId]?.[button==="bt15m"?"low":"high"]||interval;chartShift=0;void showChart();});
  $("btEarlier").addEventListener("click",()=>{chartShift-=20;void showChart();});$("btLater").addEventListener("click",()=>{chartShift+=20;void showChart();});
  $("btExport").addEventListener("click",()=>{if(!report)return;const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:"application/json"}));const link=document.createElement("a");link.href=url;link.download="codex-backtest-"+report.id+".json";link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
  async function refreshArchive(){
    archive=(await Store.all("scans")).sort((a,b)=>b.finishedAt-a.finishedAt);const picker=$("scanArchivePicker"),previous=picker.value;
    picker.replaceChildren();
    if(!archive.length){picker.append(node("option","尚無紀錄"));$("scanArchiveSummary").textContent="新版啟用後，每輪完成的掃描會保存在此裝置；目前尚無紀錄。";return;}
    for(const row of archive.slice(0,200)){const option=node("option",date(row.finishedAt)+" · "+(row.status==="COMPLETE"?"完成":"失敗／中斷")+" · "+row.rankedMarkets.length+" 合約 · "+row.candidates.length+" 候選");option.value=row.id;picker.append(option);}
    if(archive.some(row=>row.id===previous))picker.value=previous;
    $("scanArchiveSummary").textContent="已保存 "+archive.length+" 次掃描｜"+date(archive.at(-1).finishedAt)+" ～ "+date(archive[0].finishedAt)+"。選單顯示最近 200 次，資料庫保留完整紀錄。";archiveRows();
  }
  function archiveRows(){
    const scan=archive.find(row=>row.id===$("scanArchivePicker").value),body=$("scanArchiveRows");body.replaceChildren();if(!scan)return;
    scan.rankedMarkets.forEach((market,index)=>{const observations=scan.observations.filter(o=>o.symbol===market.symbol);for(const observation of (observations.length?observations:[null])){const row=node("tr");
      row.append(td(index+1),td(market.symbol),td(money(market.quoteVolume24h)),td((observation?.timeframeLabel||"舊策略")+" · "+(observation?.direction==="LONG"?"多":observation?.direction==="SHORT"?"空":"觀望")),
        td(({WAIT_ZONE:"等待區域",WAIT_SHIFT:"等待結構轉換",WAIT_RETEST:"等待OB回測",RETESTED:"歷史已回測",EXPIRED:"候選逾時",INVALIDATED:"候選失效",CANDIDATE:"等待OB回測",ERROR:"資料錯誤",NO_TREND:"舊策略觀望",NO_ENTRY:"舊策略等待"})[observation?.status]||"未完成"),td(observation?.reason||scan.error||"未取得判定結果"));body.append(row);}});
  }
  $("scanArchivePicker").addEventListener("change",archiveRows);
  window.ScanArchive={async save(state,capital,error=null){
    try{
      await Store.put("scans",{id:crypto.randomUUID(),version:1,strategyVersion:state.strategyVersion||window.SmcEngine.VERSION,asOf:state.asOf||Date.now(),
        finishedAt:Date.now()+(state.serverOffset||0),status:error?"FAILED":"COMPLETE",error,capital,
        rankedMarkets:state.rankedMarkets||[],observations:state.observations||[],candidates:state.candidates||[]});
      $("scanArchiveError").textContent="";await refreshArchive();
    }catch(error){$("scanArchiveError").textContent="本機掃描快照儲存失敗："+error.message;}
  }};
  $("btStart").value=day(Date.now()-7*86400000);$("btEnd").value=day(Date.now()-86400000);
  $("btStart").max=$("btEnd").max=day(Date.now());
  window.addEventListener("pagehide",()=>controller?.abort());
  Promise.all([refreshArchive(),refreshReports()]).catch(error=>message("本機研究資料庫無法讀取："+error.message,"error"));
})();
