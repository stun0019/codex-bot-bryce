(function (root) {
  "use strict";
  const E = root.StrategyEngine || (typeof require === "function" ? require("./strategy-engine.js") : null);
  const P = root.PaperEngine || (typeof require === "function" ? require("./paper-engine.js") : null);
  const Targets = root.TargetEngine || (typeof require === "function" ? require("./target-engine.js") : null);
  const STEP = E.INTERVALS["15m"], CLOSED = P.CLOSED;
  function validate(config) {
    if (!config || !Number.isFinite(config.start) || !Number.isFinite(config.end) || config.end <= config.start ||
        config.end - config.start > 90 * 86400000 || !(config.capital > 0) || !Number.isFinite(config.capital) ||
        ![config.feeRate,config.slippage].every(n => Number.isFinite(n) && n >= 0 && n <= .01) ||
        !["fixed","recorded"].includes(config.mode) || !["stop-first","review"].includes(config.ambiguous) ||
        !["signal","entry2r"].includes(config.targetPolicy||"signal")) throw new Error("回測參數無效：期間最多 90 天，請檢查日期、資金及費用");
  }
  function parse(rows, interval) {
    const duration = E.INTERVALS[interval];
    if (!duration || !Array.isArray(rows) || !rows.length) throw new Error("缺少 " + interval + " 歷史資料");
    const result = rows.map(row => {
      const [openTime,open,high,low,close,,closeTime] = row.map(Number);
      if (![openTime,open,high,low,close,closeTime].every(Number.isFinite) || !(low > 0) ||
          high < Math.max(open,close) || low > Math.min(open,close) || openTime % duration || closeTime !== openTime + duration - 1) throw new Error("歷史 K 線格式無效");
      return { openTime,open,high,low,close,closeTime };
    });
    for (let i=1;i<result.length;i++) if (result[i].openTime !== result[i-1].openTime + duration) throw new Error("歷史 K 線缺漏或重複，已停止回測");
    return result;
  }
  function snapshotAt(snapshots, timestamp) {
    let low=0,high=snapshots.length-1,best=null;
    while (low<=high) { const middle=(low+high)>>1, snapshot=snapshots[middle];
      if (snapshot.finishedAt<=timestamp) {best=snapshot;low=middle+1;} else high=middle-1; }
    return best && timestamp-best.finishedAt<STEP ? best : null;
  }
  function summarize(trades) {
    const closed=trades.filter(t=>CLOSED.has(t.status)).sort((a,b)=>a.closedAt-b.closedAt||a.id.localeCompare(b.id));
    let netPnl=0,peak=0,maxDrawdown=0,streak=0,maxLossStreak=0,grossProfit=0,grossLoss=0,totalR=0;
    const curve=[];
    for(const t of closed) {
      netPnl+=t.netPnl;peak=Math.max(peak,netPnl);maxDrawdown=Math.max(maxDrawdown,peak-netPnl);
      if(t.netPnl>0)grossProfit+=t.netPnl;else grossLoss-=t.netPnl;
      streak=t.netPnl<0?streak+1:0;maxLossStreak=Math.max(maxLossStreak,streak);
      totalR+=t.netPnl/t.estimatedStopRisk;curve.push({at:t.closedAt,value:netPnl});
    }
    return {targets:Targets.stats(trades),closed:closed.length,wins:closed.filter(t=>t.netPnl>0).length,
      winRate:closed.length?closed.filter(t=>t.netPnl>0).length/closed.length*100:null,netPnl,
      averagePnl:closed.length?netPnl/closed.length:null,averageR:closed.length?totalR/closed.length:null,
      grossProfit,grossLoss,profitFactor:grossLoss>0?grossProfit/grossLoss:null,maxDrawdown,maxLossStreak,
      open:trades.filter(t=>t.status==="OPEN").length,skipped:trades.filter(t=>t.status==="SKIPPED").length,
      review:trades.filter(t=>t.status==="REVIEW").length,ambiguous:trades.filter(t=>t.ambiguous).length,curve};
  }
  function groups(trades,kind) {
    const format=new Intl.DateTimeFormat("en",{timeZone:"Asia/Taipei",year:"numeric",month:"2-digit"});
    const grouped=new Map();
    for(const t of trades) {
      let key=kind==="direction"?t.direction:t.symbol;
      if(kind==="month") { const parts=format.formatToParts(new Date(t.closedAt||t.openedAt||t.confirmedAt));
        key=parts.find(p=>p.type==="year").value+"-"+parts.find(p=>p.type==="month").value; }
      if(!grouped.has(key))grouped.set(key,[]);grouped.get(key).push(t);
    }
    return [...grouped].map(([label,rows])=>({label,...summarize(rows)})).sort((a,b)=>a.label.localeCompare(b.label));
  }
  function run({config,markets,datasets,snapshots=[]},onProgress=()=>{}) {
    validate(config);
    if(!Array.isArray(markets)||!markets.length||markets.length>100)throw new Error("請選擇 1～100 個回測合約");
    const history=snapshots.filter(s=>Number.isFinite(s.finishedAt)&&Array.isArray(s.rankedMarkets)).sort((a,b)=>a.finishedAt-b.finishedAt);
    let windows=0,covered=0;
    for(let at=Math.ceil(config.start/STEP)*STEP;at<config.end;at+=STEP){windows++;if(config.mode==="fixed"||snapshotAt(history,at))covered++;}
    if(config.mode==="recorded"&&!covered)throw new Error("此期間沒有可用的已保存 Top20 快照；請選固定幣種或先累積掃描紀錄");
    const trades=[],warnings=[],pricing=P.createModel();
    for(let m=0;m<markets.length;m++) {
      const market=markets[m], source=datasets[market.symbol];
      if(!source)throw new Error("缺少 "+market.symbol+" 歷史資料");
      const fifteen=parse(source["15m"],"15m"),four=parse(source["4h"],"4h");
      if(fifteen.at(-1).closeTime<config.end-STEP||four.at(-1).closeTime<Math.floor(config.end/E.INTERVALS["4h"])*E.INTERVALS["4h"]-1)throw new Error(market.symbol+" 歷史尾端資料不足");
      let fourIndex=-1,pending=null,active=[];
      const firstDecision=fifteen[20]?.closeTime+1;
      if(fifteen.length<21||four.length<21||firstDecision>config.start||four[20]?.closeTime+1>config.start)warnings.push(market.symbol+" 部分起始時段缺乏均線暖機資料");
      for(let i=0;i<fifteen.length;i++) {
        const bar=fifteen[i],decision=bar.closeTime+1;
        if(bar.openTime>=config.end)break;
        if(pending) {
          if(bar.openTime===pending.confirmedAt) {
            const originalTarget=pending.target;
            if(config.targetPolicy==="entry2r") {
              const long=pending.direction==="LONG",tick=pending.tickSize;
              const fill=E.quantize(bar.open*(long?1+config.slippage:1-config.slippage),tick,long?"ceil":"floor");
              const distance=Math.abs(fill-pending.stopLoss);
              let target=E.quantize(fill+(long?1:-1)*2*distance,tick,long?"ceil":"floor");
              if(distance>0&&Math.abs(target-fill)/distance<2)target=Number((target+(long?tick:-tick)).toFixed(Math.min(14,E.decimals(tick))));
              pending={...pending,target};
            }
            const execution=P.createModel({version:1,settings:{enabled:true,feeRate:config.feeRate,slippage:config.slippage},trades:[]});
            execution.addCandidates([pending],config.capital,pending.confirmedAt);
            execution.tick(market.symbol,bar.open,pending.confirmedAt);
            const trade=execution.trades[0];
            if(trade) {trade.entryBarTime=bar.openTime;trade.originalTarget=originalTarget;trades.push(trade);if(trade.status==="OPEN"){trade.reason="下一根 15M 開盤價加模擬滑價";active.push(trade);}}
          }
          pending=null;
        }
        for(const trade of active) {
          Targets.bar(trade,bar,config.ambiguous);
          if(trade.status!=="OPEN")continue;
          const long=trade.direction==="LONG",gapStop=long?bar.open<=trade.stopLoss:bar.open>=trade.stopLoss;
          const gapTarget=long?bar.open>=trade.target:bar.open<=trade.target;
          const hitStop=long?bar.low<=trade.stopLoss:bar.high>=trade.stopLoss;
          const hitTarget=long?bar.high>=trade.target:bar.low<=trade.target;
          if(!hitStop&&!hitTarget){trade.lastPrice=bar.close;trade.lastQuoteAt=decision;continue;}
          const ambiguous=!gapStop&&!gapTarget&&hitStop&&hitTarget;
          if(ambiguous&&config.ambiguous==="review") {Object.assign(trade,{status:"REVIEW",ambiguous:true,reviewAt:decision,
            reason:"同根 K 同時觸及停損與目標，無法確認先後"});continue;}
          const stop=gapStop||(!gapTarget&&hitStop);
          const observed=gapStop||gapTarget?bar.open:stop?trade.stopLoss:trade.target;
          const pnl=pricing.netAt(trade,observed);
          Object.assign(trade,{status:stop?"STOP_LOSS":"TAKE_PROFIT",closedAt:gapStop||gapTarget?bar.openTime:decision,
            exitBarTime:bar.openTime,exit:pnl.exit,observedExit:observed,grossPnl:pnl.gross,exitFee:pnl.exitFee,netPnl:pnl.net,
            ambiguous,reason:ambiguous?"同根雙觸價，採保守停損優先":gapStop||gapTarget?"跳空，以開盤報價模擬市價出場":"15M 高低價觸及價位；精確盤中時間未知"});
        }
        active=active.filter(t=>t.status==="OPEN"||Targets.pending(t));
        while(fourIndex+1<four.length&&four[fourIndex+1].closeTime<decision)fourIndex++;
        if(decision<config.start||decision>=config.end||i<20||fourIndex<20)continue;
        if(four[fourIndex].closeTime!==Math.floor(decision/E.INTERVALS["4h"])*E.INTERVALS["4h"]-1)continue;
        let metadata=market;
        if(config.mode==="recorded") {
          const snapshot=snapshotAt(history,decision),found=snapshot?.rankedMarkets.find(row=>row.symbol===market.symbol);
          if(!found)continue;metadata=found;
        }
        pending=E.evaluate(metadata,four.slice(Math.max(0,fourIndex-79),fourIndex+1),
          fifteen.slice(Math.max(0,i-79),i+1),decision,config.capital);
        if(pending)pending.market={...metadata};
      }
      for(const trade of active.filter(t=>t.status==="OPEN")) {trade.unrealizedPnl=pricing.netAt(trade,trade.lastPrice).net;trade.reason="回測期末仍持倉，不列入勝率";}
      onProgress({completed:m+1,total:markets.length,symbol:market.symbol});
    }
    trades.sort((a,b)=>a.detectedAt-b.detectedAt||a.id.localeCompare(b.id));
    return {version:1,targetTrackingVersion:1,config:{...config},symbols:markets.map(m=>m.symbol),trades,stats:summarize(trades),
      coverage:{windows,covered,percent:windows?covered/windows*100:0},warnings,
      assumptions:["每筆訊號獨立使用固定參考資金，不共用保證金", "下一根 15M 開盤模擬成交；未還原逐筆成交順序", "只以已收盤 4H／15M 判斷，不使用未來 K 線",
        config.mode==="fixed"?"固定選定合約，並非當時成交額 Top20；存在選樣與生存者偏差":"僅限快照完成時間起 15 分鐘內的已保存 Top20 時段，不回填缺失排名",
        config.mode==="fixed"?"交易精度與最小下單門檻使用目前資料，未還原歷史規則變動":"交易精度採選用快照的已保存規則",
        config.targetPolicy==="entry2r"?"研究變體：依實際模擬成交價重算至少 2R 目標，與前向模擬的固定訊號目標不同":"沿用原訊號目標；成交後價差盈虧比不足 2R 即略過",
        "未計資金費率、槓桿限制與委託簿深度"]};
  }
  const api={run,parse,summarize,groups,snapshotAt,validate};
  if(typeof module!=="undefined"&&module.exports)module.exports=api;root.BacktestEngine=api;
})(typeof self!=="undefined"?self:globalThis);
