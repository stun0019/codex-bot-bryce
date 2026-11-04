(function (root) {
  "use strict";
  const E = root.StrategyEngine || (typeof require === "function" ? require("./strategy-engine.js") : null);
  const P = root.PaperEngine || (typeof require === "function" ? require("./paper-engine.js") : null);
  const Targets = root.TargetEngine || (typeof require === "function" ? require("./target-engine.js") : null);
  const Smc=root.SmcEngine||(typeof require==="function"?require("./smc-engine.js"):null);
  const STEP = E.INTERVALS["15m"], CLOSED = P.CLOSED;
  function validate(config) {
    if (!config || !Number.isFinite(config.start) || !Number.isFinite(config.end) || config.end <= config.start ||
        config.end - config.start > 100 * 86400000 || !(config.capital > 0) || !Number.isFinite(config.capital) ||
        ![config.feeRate,config.slippage].every(n => Number.isFinite(n) && n >= 0 && n <= .01) ||
        !["fixed","recorded"].includes(config.mode) || !["stop-first","review"].includes(config.ambiguous) ||
        (config.macdFilter!==undefined&&typeof config.macdFilter!=="boolean") || (config.rsiFilter!==undefined&&typeof config.rsiFilter!=="boolean") ||
        (config.targetPolicy && config.targetPolicy !== "smc") || (config.profileId && config.profileId !== "both" && !Smc.PROFILES[config.profileId])) throw new Error("回測參數無效：期間最多 100 天，請檢查日期、資金及費用");
  }
  function parse(rows, interval) {
    const duration = E.INTERVALS[interval];
    if (!duration || !Array.isArray(rows) || !rows.length) throw new Error("缺少 " + interval + " 歷史資料");
    const result = rows.map(row => {
      const [openTime,open,high,low,close,volume,closeTime] = row.map(Number);
      if (![openTime,open,high,low,close,volume,closeTime].every(Number.isFinite) || volume < 0 || !(low > 0) ||
          high < Math.max(open,close) || low > Math.min(open,close) || openTime % duration || closeTime !== openTime + duration - 1) throw new Error("歷史 K 線格式無效");
      return { openTime,open,high,low,close,volume,closeTime };
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
      if(kind==="timeframe") key=Smc.PROFILES[t.profileId]?.label||"舊策略／未標示";
      if(kind==="month") { const parts=format.formatToParts(new Date(t.closedAt||t.openedAt||t.confirmedAt));
        key=parts.find(p=>p.type==="year").value+"-"+parts.find(p=>p.type==="month").value; }
      if(!grouped.has(key))grouped.set(key,[]);grouped.get(key).push(t);
    }
    return [...grouped].map(([label,rows])=>({label,...summarize(rows)})).sort((a,b)=>a.label.localeCompare(b.label));
  }
  function run({config,markets,datasets,snapshots=[]},onProgress=()=>{}) {
    validate(config);
    if(!Array.isArray(markets)||!markets.length||markets.length>100)throw new Error("請選擇 1～100 個回測合約");
    const profiles=config.profileId&&config.profileId!=="both"?[Smc.profile(config.profileId)]:Object.values(Smc.PROFILES);
    const history=snapshots.filter(s=>Number.isFinite(s.finishedAt)&&Array.isArray(s.rankedMarkets)).sort((a,b)=>a.finishedAt-b.finishedAt);
    const trades=[],warnings=[],dataCoverage=[];let windows=0,covered=0,completed=0;
    for(const market of markets)for(const profile of profiles){
      const source=datasets[market.symbol],step=E.INTERVALS[profile.low];
      if(!source||!source[profile.high]?.length||!source[profile.low]?.length){warnings.push(market.symbol+" "+profile.label+" 無可用歷史資料");dataCoverage.push({symbol:market.symbol,profileId:profile.id,percent:0});onProgress({completed:++completed,total:markets.length*profiles.length,symbol:market.symbol+" "+profile.label});continue;}
      const lower=parse(source[profile.low],profile.low),higher=parse(source[profile.high],profile.high);
      if(lower.at(-1).closeTime<config.end-step||higher.at(-1).closeTime<Math.floor(config.end/E.INTERVALS[profile.high])*E.INTERVALS[profile.high]-1)throw new Error(market.symbol+" 歷史尾端資料不足");
      const analyzer=Smc.createAnalyzer(profile.id,{macdFilter:config.macdFilter!==false,rsiFilter:config.rsiFilter===true}),model=P.createModel({version:1,settings:{enabled:true,feeRate:config.feeRate,slippage:config.slippage},trades:[]});
      let h=0,state=null,available=0;
      const add=(candidate,at)=>{
        if(!candidate||at<config.start||at>=config.end)return;
        if(config.mode==="recorded"&&!snapshotAt(history,candidate.confirmedAt)?.rankedMarkets.some(m=>m.symbol===market.symbol))return;
        model.addCandidates([candidate],config.capital,at);
      };
      for(const bar of lower){
        if(bar.openTime>=config.end)break;const at=bar.openTime,decision=bar.closeTime+1;
        if(at>=config.start){
          windows++;if(config.mode==="fixed"||snapshotAt(history,at))covered++;
          if(h>=(config.macdFilter===false?20:100))available++;
          if(state?.pending)add(state.pending,at);
          for(const trade of model.trades){
            let entryInRange=false;
            if(trade.status==="WAITING_PRICE"){
              if(at>=trade.expiresAt){model.cancelOrder(trade,"等待 OB 回測逾時",at);continue;}
              const long=trade.direction==="LONG",marketable=long?bar.open<=trade.referenceEntry:bar.open>=trade.referenceEntry;
              if(marketable)model.tryLimitFill(trade,bar.open,at);
              else if(long?bar.open>=trade.target:bar.open<=trade.target)model.cancelOrder(trade,"進場前已到 TP1",at);
              else if(long?bar.low<=trade.referenceEntry:bar.high>=trade.referenceEntry){model.tryLimitFill(trade,trade.referenceEntry,at);entryInRange=trade.status==="OPEN";}
              if(trade.status==="OPEN")trade.entryBarTime=at;
            }
            if(trade.status!=="OPEN"&&!Targets.pending(trade))continue;
            const long=trade.direction==="LONG",hitStop=long?bar.low<=trade.stopLoss:bar.high>=trade.stopLoss;
            if(entryInRange){
              if(hitStop){Targets.quote(trade,trade.stopLoss,decision);model.executeSmc(trade,trade.stopLoss,decision,"historical");trade.exitBarTime=at;}
              trade.lastPrice=bar.close;trade.lastQuoteAt=decision;continue;
            }
            Targets.quote(trade,bar.open,at);model.executeSmc(trade,bar.open,at,"historical");
            const hitNext=trade.exitLegs?.some(l=>l.status==="PENDING"&&(long?bar.high>=l.price:bar.low<=l.price));
            const ambiguous=trade.status==="OPEN"&&hitStop&&hitNext;
            if(ambiguous&&config.ambiguous==="review"){
              Object.assign(trade,{status:"REVIEW",reviewAt:decision,ambiguous:true,reason:"同根止損與分批目標雙觸價，剩餘部位出場順序不確定"});
            }else if(trade.status==="OPEN"){
              if(hitStop)model.executeSmc(trade,trade.stopLoss,decision,"historical");
              else for(const leg of trade.exitLegs)if(leg.status==="PENDING"&&(long?bar.high>=leg.price:bar.low<=leg.price))model.executeSmc(trade,leg.price,decision,"historical");
              if(ambiguous)trade.ambiguous=true;
            }
            Targets.bar(trade,bar,config.ambiguous);
            if(CLOSED.has(trade.status)&&trade.exitBarTime===undefined)trade.exitBarTime=at;
            trade.lastPrice=bar.close;trade.lastQuoteAt=decision;
          }
        }
        while(h<higher.length&&higher[h].closeTime<=bar.closeTime)analyzer.pushHigh(higher[h++]);
        if(h){state=analyzer.pushLow(bar,market,config.capital);if(decision>=config.start&&decision<config.end){
          for(const trade of model.trades)if(trade.status==="WAITING_PRICE"&&trade.setupId!==state.pending?.setupId)model.cancelOrder(trade,"區域失效／歷史已回測或等待逾時",decision);
          add(state.candidate,decision);
        }}
      }
      for(const trade of model.trades){if(trade.status==="OPEN")trade.unrealizedPnl=model.netAt(trade,trade.lastPrice).net;if(trade.status==="WAITING_PRICE")trade.reason="期末尚未回測 OB，不列入勝率";trades.push(trade);}
      const expected=Math.ceil((config.end-config.start)/step),percent=Math.min(100,available/expected*100);
      dataCoverage.push({symbol:market.symbol,profileId:profile.id,percent});if(percent<99.99)warnings.push(market.symbol+" "+profile.label+" 行情與高週期暖機覆蓋 "+percent.toFixed(1)+"%，可能為新上市合約");
      onProgress({completed:++completed,total:markets.length*profiles.length,symbol:market.symbol+" "+profile.label});
    }
    if(config.mode==="recorded"&&!covered)throw new Error("此期間沒有可用的已保存 Top20 快照；不推測歷史排名");
    trades.sort((a,b)=>a.detectedAt-b.detectedAt||a.id.localeCompare(b.id));
    return {version:2,strategyVersion:config.macdFilter===false?Smc.LEGACY_VERSION:Smc.VERSION,targetTrackingVersion:2,config:{...config,targetPolicy:"smc"},symbols:markets.map(m=>m.symbol),trades,stats:summarize(trades),dataCoverage,
      coverage:{windows,covered,percent:windows?covered/windows*100:0},warnings,
      assumptions:[config.macdFilter===false?"舊版對照：不使用MACD方向過濾":"高週期MACD(12,26,9)主線DIF：正值只多、負值只空、0觀望；固定最近100根已收盤K線暖機",config.rsiFilter?"額外過濾：最新已收盤低週期RSI14(最近250根Wilder)多<30／空>70，成交量≥前根3倍；未通過不新增，取消未成交，持倉延續":"RSI＋放量額外過濾關閉","SMC 高週期 OB／FVG＋低週期 CHoCH 後等待 OB 中線限價回測；兩套時間框架獨立", "確認轉折左右各2根；ATR14前值×1.2位移，回找6根內最後反向K；高週期區域80根後失效", "觸區等結構、結構後等回測各最多1根高週期時間；高週期收盤越過OB遠端取消未成交候選", "TP1 2R出原部位30%、TP2 3R出30%、TP3 4R出剩餘；TP4 5R僅觀察；原停損不移動", "每筆獨立固定參考資金、風險5%含估算成本，不共用保證金，累計損益不是帳戶報酬率", "限價以OB中線模擬、不計進場滑價；單邊費率與出場不利滑價依設定；分批數量按step向下取整", "OHLC根內回測進場只計可能停損，不計同根止盈；已在開盤成交者可正常追蹤該根", "同根雙觸價依保守停損優先／不確定模式；跳空可能超出5%預算",config.mode==="fixed"?"固定目前合約與交易精度，不是當時Top20，有選樣及生存者偏差":"僅使用當時已完成保存的Top20排名快照，不回填缺漏", "未計資金費率、強制平倉、槓桿級距與委託簿深度；不保證績效"]};
  }
  const api={run,parse,summarize,groups,snapshotAt,validate};
  if(typeof module!=="undefined"&&module.exports)module.exports=api;root.BacktestEngine=api;
})(typeof self!=="undefined"?self:globalThis);
