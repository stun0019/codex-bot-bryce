(function () {
  "use strict";
  const Engine = window.StrategyEngine, client = window.StrategyData.createClient();
  const $ = id => document.getElementById(id);
  const list = $("strategyList"), count = $("candidateCount"), status = $("scannerStatus");
  const progress = $("scanProgress"), meter = $("scanMeter"), updated = $("lastUpdate");
  const rsiToggle = $("rsiEntryFilter");
  rsiToggle.checked=false; rsiToggle.closest("label").hidden=true;
  function filterStatus(){ $("entryFilterStatus").textContent=rsiToggle.checked ? "已啟用：低週期多 RSI＜30／空 RSI＞70，且量≥前根3倍" : "RSI＋放量過濾：關閉"; }
  filterStatus();
  const capitalInput = $("capitalInput"), filter = $("directionFilter"), refresh = $("refreshBtn");
  const recordStore=window.CandidateRecords.create({getItem:key=>localStorage.getItem(key),setItem:(key,value)=>localStorage.setItem(key,value)});
  let capital = Engine.SETTINGS.capital, candidates = [], busy = false, offset = 0;
  let watchCandidates=[];
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

  function card(candidate,plan,retained=false){const snapshot=window.PaperTrading?.cardSnapshot(candidate);return window.TradeCards.render({...candidate,referenceEntry:candidate.entry,...(snapshot||{}),...(snapshot?{}:{status:'NOT_ENTERED',reason:busy?'掃描中，尚未預留':plan.reason})},{plan,pnl:snapshot?.cardPnl??null,retained,now:Date.now()+offset});}

  function visibleCandidates() {
    const merged=new Map(recordStore.list().filter(r=>window.MacdStrategy.isVersion(r.candidate.strategyVersion)).map(r=>[window.PaperEngine.key(r.candidate),r.candidate]));
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
    const watches=watchCandidates.filter(o=>filter.value==="all"||filter.value===o.direction);
    count.textContent="("+(all.length+watches.length)+" 候選 · "+all.length+" 已確認進場)";
    for(const o of watches)list.append(window.TradeCards.render({...o,strategyVersion:window.MacdStrategy.VERSION,timeframeLabel:'4H＋15M'},{watch:true,now:Date.now()+offset}));
    if (!visible.length&&!watches.length) {
      const empty = node("div", "strategy-empty");
      empty.append(node("strong", "", busy ? "正在確認策略條件" : "目前沒有符合條件的候選"),
        node("p", "", busy ? "檢查4H與15M的MACD零軸方向、放量BOS及回抽確認。" :
          completed ? "等待MACD同向與15M回抽確認；每5分鐘更新。" : "請更新掃描，或等待連線恢復。"));
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
      watchCandidates=outcome.observations.filter(o=>o.direction&&o.status!=="CANDIDATE"); candidates = outcome.candidates; completed = true; recordStore.update(candidates,outcome.asOf);
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
