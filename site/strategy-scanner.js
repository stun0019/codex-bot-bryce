(function () {
  "use strict";
  const Engine = window.StrategyEngine, client = window.StrategyData.createClient();
  const $ = id => document.getElementById(id);
  const list = $("strategyList"), count = $("candidateCount"), status = $("scannerStatus");
  const progress = $("scanProgress"), meter = $("scanMeter"), updated = $("lastUpdate");
  const rsiToggle = $("rsiEntryFilter");
  try { rsiToggle.checked = localStorage.getItem("codex-smc-rsi-filter") === "true"; } catch {}
  function filterStatus(){ $("entryFilterStatus").textContent=rsiToggle.checked ? "已啟用：低週期多 RSI＜30／空 RSI＞70，且量≥前根3倍" : "RSI＋放量過濾：關閉"; }
  filterStatus();
  const capitalInput = $("capitalInput"), filter = $("directionFilter"), refresh = $("refreshBtn");
  const recordStore=window.CandidateRecords.create({getItem:key=>localStorage.getItem(key),setItem:(key,value)=>localStorage.setItem(key,value)});
  let capital = Engine.SETTINGS.capital, candidates = [], busy = false, offset = 0;
  let nextScanAt = 0, completed = false, lastVisibleKey = "", currentController = null;
  const money = value => new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
  const number = (value, step) => new Intl.NumberFormat("en-US", { maximumFractionDigits: Math.min(14, Engine.decimals(step)) }).format(value);
  const time = value => new Date(value).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false });
  capitalInput.value = String(capital); capitalInput.readOnly = true;

  function node(tag, className, value) {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (value != null) result.textContent = value;
    return result;
  }

  function metric(label, value) {
    const cell = node("div", "strategy-metric");
    cell.append(node("dt", "", label), node("dd", "", value));
    return cell;
  }

  function card(candidate, plan, retained=false) {
    const long = candidate.direction === "LONG";
    const result = node("article", "strategy-card");
    result.dataset.direction = candidate.direction;
    result.dataset.key = candidate.symbol + ":" + candidate.profileId + ":" + candidate.setupId;
    const head = node("div", "strategy-card-head");
    const identity = node("div", "strategy-card-identity");
    identity.append(node("span", "strategy-token", candidate.symbol.replace(/^1000/, "").slice(0, 1)), node("h2", "strategy-symbol", candidate.symbol));
    const badgeColumn=node("div","strategy-badge-column"),trade=window.PaperTrading?.recordStatus(candidate);
    const tradeState=trade?.status,label=tradeState==="OPEN"?(trade.recovering?"已進場 · 核對中":"已進場"):tradeState==="TAKE_PROFIT"||tradeState==="STOP_LOSS"?"已平倉":tradeState==="WAITING_PRICE"?"待進場":tradeState==="REVIEW"?(trade.entered?"已進場 · 待核對":"待核對"):tradeState==="SKIPPED"?"已取消":busy&&!retained?"掃描中":!retained&&plan.ok?"待預留":"未進場";
    const tradeLabel=node("span","candidate-trade-state",label);tradeLabel.dataset.state=tradeState||"UNRECORDED";tradeLabel.title=trade?.reason||plan.reason||"等待完成掃描與帳戶預留";
    badgeColumn.append(node("span","strategy-badge",long?"做多候選":"做空候選"),tradeLabel);head.append(identity,badgeColumn);
    const subtitle = node("p", "strategy-subtitle", "高週期區域 → 小週期收盤破結構 → Fib 0.715");
    const timeframe = node("p", "strategy-timeframe", "EMA＋Fib · " + candidate.timeframeLabel + (retained ? " · 保留紀錄" : " · 本輪候選"));
    const prices = node("dl", "strategy-prices");
    prices.append(metric("進場參考 · Fib 0.715", number(candidate.entry, candidate.tickSize)),
      metric("停損", number(candidate.stopLoss, candidate.tickSize)), ...candidate.targets.slice(0,3).map((target,index) => metric("TP" + (index + 1) + " · "+["20%","30%","30%"][index], number(target, candidate.tickSize))));
    prices.append(metric("TP4 · 20%",number(candidate.targets[3],candidate.tickSize)),metric("目前保護價",trade?.exitGuard?number(trade.exitGuard.price,candidate.tickSize):"—"));
    const execution = node("p", "execution-status", tradeState==="TAKE_PROFIT"||tradeState==="STOP_LOSS" ? "已平倉 · "+(trade.reason||"原計畫已完成") : tradeState==="SKIPPED" ? "未進場 · "+trade.reason : busy ? "掃描中 · 尚未預留" : plan.ok ? plan.status === "RESERVED" ? "已預留 · 成交前再核驗" : plan.status === "OPEN" ? "已進場 · 數量固定" : "待共用帳戶預留" : "風控未通過：" + plan.reason);
    execution.dataset.state = plan.ok && !busy ? "ready" : "blocked";
    const rr = Math.abs(candidate.target - candidate.entry) / Math.abs(candidate.entry - candidate.stopLoss);
    const foot = node("p", "strategy-foot", "破結構後預掛 · TP1價差 " + rr.toFixed(2).replace(/\.00$/, "") + "R · 等待執行");
    const risk = node("p", "strategy-risk", plan.ok ?
      "部位 " + number(plan.quantity, candidate.stepSize) + " · 估算風險 " + money(plan.risk) + " USDT · 四段全成淨利估算 " + money(plan.profit) + " USDT" : plan.reason);
    risk.dataset.state = plan.ok ? "ready" : "blocked";
    const details = node("details", "strategy-details");
    details.append(node("summary", "", "詳細資訊"));
    const detailList = node("dl", "strategy-calculations");
    detailList.append(metric("大框架 EMA20",number(candidate.emaTrend.ema20,candidate.tickSize)),metric("大框架 EMA60",number(candidate.emaTrend.ema60,candidate.tickSize)),metric("大框架 EMA200",number(candidate.emaTrend.ema200,candidate.tickSize)),
      metric("Fib A（1）",number(candidate.fib.a.price,candidate.tickSize)),metric("Fib B（0）",number(candidate.fib.b.price,candidate.tickSize)),metric("0.715觸發價",number(window.FibEngine.prices(candidate.fib,candidate.direction,candidate.tickSize).entry,candidate.tickSize)),metric("RSI＋放量過濾",candidate.entryFilter?.enabled?"RSI "+candidate.entryFilter.rsi.toFixed(2)+" · 量 "+candidate.entryFilter.volumeRatio.toFixed(2)+" 倍":"關閉"),
      metric("保證金及費用預留",plan.ok?money(plan.marginReserve)+" USDT":"—"),metric("數量來源","卡片與模擬共用含成本預留計畫"),metric("確認時間（台北）",time(candidate.confirmedAt)),metric("候選到期",time(candidate.expiresAt)),metric("分批出場","TP1 20% · TP2 30% · TP3 30% · TP4剩餘20%；回撤上一個已達TP則全出"));
    detailList.prepend(metric("原始部位數量",trade?.quantity?number(trade.quantity,candidate.stepSize):plan.ok?number(plan.quantity,candidate.stepSize):"未預留"),metric("含成本停損風險",trade?.estimatedStopRisk?money(trade.estimatedStopRisk)+" USDT":plan.ok?money(plan.risk)+" USDT":"—"),metric("已平倉淨損益",Number.isFinite(trade?.netPnl)?money(trade.netPnl)+" USDT":"—"),metric("TP4 · Fib −1",number(candidate.targets[3],candidate.tickSize)));
    details.append(execution,subtitle, foot, risk, detailList);
    const confirmed = node("p", "strategy-confirmed", "確認時間 " + time(candidate.confirmedAt) + " · BINANCE 永續");
    result.append(head, timeframe, confirmed, prices, details);
    return result;
  }

  function visibleCandidates() {
    const merged=new Map(recordStore.list().filter(r=>window.FibEngine.isVersion(r.candidate.strategyVersion)).map(r=>[window.PaperEngine.key(r.candidate),r.candidate]));
    for(const c of candidates)merged.set(window.PaperEngine.key(c),c);
    return [...merged.values()].filter(candidate=>(filter.value==="all"||candidate.direction===filter.value)&&($("timeframeFilter").value==="all"||candidate.profileId===$("timeframeFilter").value)).sort((a,b)=>b.confirmedAt-a.confirmedAt||a.symbol.localeCompare(b.symbol));
  }

  function render() {
    const expanded = new Set([...list.querySelectorAll(".strategy-card")].filter(card => card.querySelector("details")?.open).map(card => card.dataset.key));
    const account = window.PaperTrading?.accountState(); capital = account?.initialCapital || 200; capitalInput.value = String(capital);
    $("riskBudget").textContent = money((account?.riskCapital ?? capital) * Engine.SETTINGS.riskFraction) + " USDT";
    const visible = visibleCandidates(),currentKeys=new Set(candidates.map(window.PaperEngine.key));
    const plans = window.PaperTrading?.previewCandidates(visible.filter(c=>currentKeys.has(window.PaperEngine.key(c))||window.PaperTrading?.recordStatus(c)), capital) || new Map();
    const all = candidates.filter(c => c.expiresAt > Date.now() + offset);
    count.textContent = "(" + all.length + " 候選 · " + visible.length + " 紀錄)";
    $("candidateRecordStatus").textContent=recordStore.getError()?"候選卡片保存失敗："+recordStore.getError():"最近200筆候選保存在本機，刷新／更新後保留；只作紀錄，不重新開倉。";
    window.DashboardUI?.setCandidates(all.length);
    lastVisibleKey = visible.map(c => c.symbol + c.profileId + c.setupId).join(",");
    list.replaceChildren();
    if (!visible.length) {
      const empty = node("div", "strategy-empty");
      empty.append(node("strong", "", busy ? "正在確認策略條件" : "目前沒有符合條件的候選"),
        node("p", "", busy ? "分別檢查EMA排列、高週期區域、小週期收盤破結構與Fib波段。" :
          completed ? "等待高框架觸區、收盤破結構及L1確認；每5分鐘更新。" : "請更新掃描，或等待連線恢復。"));
      list.append(empty);
    } else visible.forEach(candidate => {
      const retained=!currentKeys.has(window.PaperEngine.key(candidate));
      let plan=plans.get(window.PaperEngine.key(candidate))||{ok:false,reason:"共用帳戶尚未就緒"};
      if(retained&&!window.PaperTrading?.recordStatus(candidate))plan={ok:false,reason:"保留紀錄，未建立模擬訂單"};
      const item = card(candidate,plan,retained);
      if (expanded.has(item.dataset.key)) item.querySelector("details").open = true;
      list.append(item);
    });
  }

  async function run() {
    if (busy) return;
    window.PaperTrading?.beginScan();
    window.dispatchEvent(new Event("strategy-scan-start"));
    busy = true; completed = false; candidates = [];
    currentController = new AbortController();
    refresh.disabled = true; rsiToggle.disabled = true; refresh.textContent = "掃描中…";
    list.setAttribute("aria-busy", "true");
    status.textContent = "連接幣安"; status.dataset.state = "pending";
    progress.textContent = "讀取 24H 成交額 Top20 與已收盤 K 線"; meter.value = 0; meter.max = 1;
    render();
    let scanState = null;
    try {
      const outcome = await client.scan({ capital, rsiFilter:rsiToggle.checked, signal: currentController.signal, onProgress(state) {
        scanState = state;
        offset = state.serverOffset;
        candidates = state.candidates;
        window.PaperTrading?.acceptCandidates(state.candidates, capital, Date.now() + offset);
        status.textContent = "策略掃描中";
        progress.textContent = "成交額 Top20 · 已掃描 " + state.completed + " / " + state.total + " · 趨勢方向已確認 " + state.trending +
          (state.errors ? " · 資料不可用 " + state.errors : "");
        meter.max = state.total; meter.value = state.completed;
        if (visibleCandidates().map(c => c.symbol + c.profileId + c.setupId).join(",") !== lastVisibleKey) render();
      } });
      candidates = outcome.candidates; completed = true; recordStore.update(candidates,outcome.asOf);
      window.dispatchEvent(new Event("candidate-records-update"));
      window.PaperTrading?.reconcileCandidates(outcome.candidates, outcome.observations, Date.now() + offset);
      window.PaperTrading?.acceptCandidates(outcome.candidates, capital, Date.now() + offset, true);

      status.textContent = outcome.errors ? "掃描完成 · 部分資料不可用" : "掃描完成";
      status.dataset.state = outcome.errors ? "partial" : "live";
      updated.dateTime = new Date(Date.now() + offset).toISOString();
      updated.textContent = "更新於 " + time(Date.now() + offset) + "（台北）";
      nextScanAt = Math.floor(outcome.asOf / Engine.INTERVALS["5m"] + 1) * Engine.INTERVALS["5m"] + 3000;
      if (outcome.errors) console.info("Strategy scanner skipped unavailable data:", outcome.failures);
    } catch (error) {

      candidates = []; // Do not present partial or failed scans as completed signals.
      status.textContent = error.retryAt ? "請求限流 · 等待重試" : error.name === "AbortError" ? "掃描已停止" : "連線失敗 · 等待重試";
      status.dataset.state = "error";
      progress.textContent = error.name === "AbortError" ? "重新整理頁面可再次掃描。" : error.message + "；可稍後按更新。";
      nextScanAt = Math.max(error.retryAt || 0, Date.now() + 60000) + offset;
      console.warn("Strategy scanner:", error);
    } finally {
      busy = false; currentController = null;
      refresh.disabled = false; rsiToggle.disabled = false; refresh.textContent = "更新";
      list.setAttribute("aria-busy", "false");
      render();
    }
  }

  rsiToggle.addEventListener("change",()=>{try{localStorage.setItem("codex-smc-rsi-filter",String(rsiToggle.checked));}catch{}filterStatus(); window.PaperTrading?.invalidatePending("候選過濾設定變更，取消未成交預留；等待新掃描"); window.dispatchEvent(new CustomEvent("entry-filter-change",{detail:{enabled:rsiToggle.checked}}));void run();});
  window.addEventListener("paper-records-cleared",()=>{recordStore.clear();candidates=[];render();});
  window.addEventListener("paper-account-update", render);
  filter.addEventListener("change", render);
  $("timeframeFilter").addEventListener("change", render);
  refresh.addEventListener("click", () => { if (Date.now() >= client.getBackoffUntil()) void run(); });
  window.addEventListener("pagehide", () => currentController?.abort());
  setInterval(() => {
    if (document.visibilityState === "hidden") return;
    const key = visibleCandidates().map(c => c.symbol + c.profileId + c.setupId).join(",");
    if (key !== lastVisibleKey) render();
    if (!busy && Date.now() + offset >= nextScanAt && navigator.onLine !== false) void run();
  }, 1000);
  void run();
})();
