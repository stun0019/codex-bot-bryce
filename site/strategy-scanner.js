(function () {
  "use strict";
  const Engine = window.StrategyEngine, client = window.StrategyData.createClient();
  const $ = id => document.getElementById(id);
  const list = $("strategyList"), count = $("candidateCount"), status = $("scannerStatus");
  const progress = $("scanProgress"), meter = $("scanMeter"), updated = $("lastUpdate");
  const capitalInput = $("capitalInput"), filter = $("directionFilter"), refresh = $("refreshBtn");
  let capital = Engine.SETTINGS.capital, candidates = [], busy = false, offset = 0;
  let nextScanAt = 0, completed = false, lastVisibleKey = "", currentController = null;
  const money = value => new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
  const number = (value, step) => new Intl.NumberFormat("en-US", { maximumFractionDigits: Math.min(14, Engine.decimals(step)) }).format(value);
  const time = value => new Date(value).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false });
  try {
    const saved = Number(localStorage.getItem("codex-smc-capital-v1"));
    if (Number.isFinite(saved) && saved > 0) capital = saved;
  } catch (_) { /* storage is optional */ }
  capitalInput.value = String(capital);

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

  function card(candidate) {
    const long = candidate.direction === "LONG", plan = Engine.position(candidate, candidate.market, capital);
    const result = node("article", "strategy-card");
    result.dataset.direction = candidate.direction;
    result.dataset.key = candidate.symbol + ":" + candidate.profileId + ":" + candidate.setupId;
    const head = node("div", "strategy-card-head");
    const identity = node("div", "strategy-card-identity");
    identity.append(node("span", "strategy-token", candidate.symbol.replace(/^1000/, "").slice(0, 1)), node("h2", "strategy-symbol", candidate.symbol));
    head.append(identity, node("span", "strategy-badge", long ? "做多候選" : "做空候選"));
    const subtitle = node("p", "strategy-subtitle", "高週期區域 → CHoCH → 等待 OB 中線回測");
    const timeframe = node("p", "strategy-timeframe", "SMC · " + candidate.timeframeLabel + " · 等待 OB 回測");
    const prices = node("dl", "strategy-prices");
    prices.append(metric("進場參考", number(candidate.entry, candidate.tickSize)),
      metric("停損", number(candidate.stopLoss, candidate.tickSize)), ...Engine.targets(candidate.entry, candidate.stopLoss, candidate.direction, candidate.tickSize).map((target,index) => metric("TP" + (index + 1) + " · 1:" + (index + 2), target == null ? "無效價位" : number(target, candidate.tickSize))));
    const rr = Math.abs(candidate.target - candidate.entry) / Math.abs(candidate.entry - candidate.stopLoss);
    const foot = node("p", "strategy-foot", "SMC 結構確認 · 預估 " + rr.toFixed(2).replace(/\.00$/, "") + "R · 等待執行");
    const risk = node("p", "strategy-risk", plan.ok ?
      "部位 " + number(plan.quantity, candidate.stepSize) + " · 估算風險 " + money(plan.risk) + " USDT · 目標獲利 " + money(plan.profit) + " USDT" : plan.reason);
    risk.dataset.state = plan.ok ? "ready" : "blocked";
    const details = node("details", "strategy-details");
    details.append(node("summary", "", "詳細資訊"));
    const detailList = node("dl", "strategy-calculations");
    detailList.append(metric("高週期 OB", number(candidate.highZone.low, candidate.tickSize) + " ～ " + number(candidate.highZone.high, candidate.tickSize)),
      metric("高週期 FVG", candidate.highZone.fvg ? number(candidate.highZone.fvg.low, candidate.tickSize) + " ～ " + number(candidate.highZone.fvg.high, candidate.tickSize) : "無同向 FVG（非必要條件）"),
      metric("進場 OB", number(candidate.entryZone.low, candidate.tickSize) + " ～ " + number(candidate.entryZone.high, candidate.tickSize)),
      metric("結構轉換價", number(candidate.shiftLevel, candidate.tickSize)),metric("確認時間（台北）", time(candidate.confirmedAt)),metric("候選到期", time(candidate.expiresAt)),
      metric("分批出場", "TP1 30% · TP2 30% · TP3 剩餘全部；TP4 僅觀察"));
    details.append(subtitle, foot, risk, detailList);
    const confirmed = node("p", "strategy-confirmed", "確認時間 " + time(candidate.confirmedAt) + " · BINANCE 永續");
    result.append(head, timeframe, confirmed, prices, details);
    return result;
  }

  function visibleCandidates() {
    const now = Date.now() + offset;
    return candidates.filter(candidate => candidate.expiresAt > now &&
      (filter.value === "all" || candidate.direction === filter.value) && ($("timeframeFilter").value === "all" || candidate.profileId === $("timeframeFilter").value)).sort((a,b) => a.symbol.localeCompare(b.symbol));
  }

  function render() {
    const expanded = new Set([...list.querySelectorAll(".strategy-card")].filter(card => card.querySelector("details")?.open).map(card => card.dataset.key));
    $("riskBudget").textContent = money(capital * Engine.SETTINGS.riskFraction) + " USDT";
    const visible = visibleCandidates(), all = candidates.filter(c => c.expiresAt > Date.now() + offset);
    count.textContent = "(" + visible.length + " / " + all.length + ")";
    window.DashboardUI?.setCandidates(all.length);
    lastVisibleKey = visible.map(c => c.symbol + c.profileId + c.setupId).join(",");
    list.replaceChildren();
    if (!visible.length) {
      const empty = node("div", "strategy-empty");
      empty.append(node("strong", "", busy ? "正在確認策略條件" : "目前沒有符合條件的候選"),
        node("p", "", busy ? "分別檢查 4H＋15M、1H＋5M 的 OB、結構轉換與回測候選。" :
          completed ? "等待高週期區域、低週期結構轉換與有效 OB；每 5 分鐘更新，兩套週期獨立。" : "請更新掃描，或等待連線恢復。"));
      list.append(empty);
    } else visible.forEach(candidate => {
      const item = card(candidate);
      if (expanded.has(item.dataset.key)) item.querySelector("details").open = true;
      list.append(item);
    });
  }

  async function run() {
    if (busy) return;
    window.dispatchEvent(new Event("strategy-scan-start"));
    busy = true; completed = false; candidates = [];
    currentController = new AbortController();
    refresh.disabled = true; refresh.textContent = "掃描中…";
    list.setAttribute("aria-busy", "true");
    status.textContent = "連接幣安"; status.dataset.state = "pending";
    progress.textContent = "讀取 24H 成交額 Top20 與已收盤 K 線"; meter.value = 0; meter.max = 1;
    render();
    let scanState = null;
    try {
      const outcome = await client.scan({ capital, signal: currentController.signal, onProgress(state) {
        scanState = state;
        offset = state.serverOffset;
        candidates = state.candidates;
        window.PaperTrading?.acceptCandidates(state.candidates, capital, Date.now() + offset);
        status.textContent = "策略掃描中";
        progress.textContent = "成交額 Top20 · 已掃描 " + state.completed + " / " + state.total + " · 區域進場監控 " + state.trending +
          (state.errors ? " · 資料不可用 " + state.errors : "");
        meter.max = state.total; meter.value = state.completed;
        if (visibleCandidates().map(c => c.symbol + c.profileId + c.setupId).join(",") !== lastVisibleKey) render();
      } });
      candidates = outcome.candidates; completed = true;
      window.PaperTrading?.reconcileCandidates(outcome.candidates, outcome.observations, Date.now() + offset);
      void window.ScanArchive?.save(outcome, capital);
      status.textContent = outcome.errors ? "掃描完成 · 部分資料不可用" : "掃描完成";
      status.dataset.state = outcome.errors ? "partial" : "live";
      updated.dateTime = new Date(Date.now() + offset).toISOString();
      updated.textContent = "更新於 " + time(Date.now() + offset) + "（台北）";
      nextScanAt = Math.floor(outcome.asOf / Engine.INTERVALS["5m"] + 1) * Engine.INTERVALS["5m"] + 3000;
      if (outcome.errors) console.info("Strategy scanner skipped unavailable data:", outcome.failures);
    } catch (error) {
      void window.ScanArchive?.save(scanState || { asOf: Date.now() + offset, serverOffset: offset }, capital, error.message);
      candidates = []; // Do not present partial or failed scans as completed signals.
      status.textContent = error.retryAt ? "請求限流 · 等待重試" : error.name === "AbortError" ? "掃描已停止" : "連線失敗 · 等待重試";
      status.dataset.state = "error";
      progress.textContent = error.name === "AbortError" ? "重新整理頁面可再次掃描。" : error.message + "；可稍後按更新。";
      nextScanAt = Math.max(error.retryAt || 0, Date.now() + 60000) + offset;
      console.warn("Strategy scanner:", error);
    } finally {
      busy = false; currentController = null;
      refresh.disabled = false; refresh.textContent = "更新";
      list.setAttribute("aria-busy", "false");
      render();
    }
  }

  capitalInput.addEventListener("change", () => {
    const value = Number(capitalInput.value);
    if (!Number.isFinite(value) || value <= 0) {
      capitalInput.setCustomValidity("請輸入大於 0 的總資金"); capitalInput.reportValidity(); return;
    }
    capitalInput.setCustomValidity(""); capital = value;
    try { localStorage.setItem("codex-smc-capital-v1", String(capital)); } catch (_) { /* optional */ }
    render();
  });
  capitalInput.addEventListener("input", () => capitalInput.setCustomValidity(""));
  capitalInput.addEventListener("input", () => {
    const value = Number(capitalInput.value);
    if (Number.isFinite(value) && value > 0) {
      capital = value;
      try { localStorage.setItem("codex-smc-capital-v1", String(capital)); } catch (_) { /* optional */ }
      render();
    }
  });
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
