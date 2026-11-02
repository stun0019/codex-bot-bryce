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
    const saved = Number(localStorage.getItem("codex-strategy-capital-v1"));
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
    result.dataset.key = candidate.symbol + ":" + candidate.confirmedAt;
    const head = node("div", "strategy-card-head");
    head.append(node("h2", "strategy-symbol", candidate.symbol), node("span", "strategy-badge", long ? "做多候選" : "做空候選"));
    const subtitle = node("p", "strategy-subtitle", long ? "4H 多頭確認 · 15M 回踩完成" : "4H 空頭確認 · 15M 反彈完成");
    const prices = node("dl", "strategy-prices");
    prices.append(metric("進場參考", number(candidate.entry, candidate.tickSize)),
      metric("停損", number(candidate.stopLoss, candidate.tickSize)), metric("目標", number(candidate.target, candidate.tickSize)));
    const rr = Math.abs(candidate.target - candidate.entry) / Math.abs(candidate.entry - candidate.stopLoss);
    const foot = node("p", "strategy-foot", "價格／均線確認 · 預估 " + rr.toFixed(2).replace(/\.00$/, "") + "R · 等待執行");
    const risk = node("p", "strategy-risk", plan.ok ?
      "部位 " + number(plan.quantity, candidate.stepSize) + " · 估算風險 " + money(plan.risk) + " USDT · 目標獲利 " + money(plan.profit) + " USDT" : plan.reason);
    risk.dataset.state = plan.ok ? "ready" : "blocked";
    const details = node("details", "strategy-details");
    details.append(node("summary", "", "檢視計算"));
    const detailList = node("dl", "strategy-calculations");
    detailList.append(metric("4H MA20", number(candidate.ma4h20, candidate.tickSize)),
      metric("15M MA5", number(candidate.ma15m5, candidate.tickSize)),
      metric("15M MA10／MA20", number(candidate.ma15m10, candidate.tickSize) + " / " + number(candidate.ma15m20, candidate.tickSize)),
      metric("15M 確認時間（台北）", time(candidate.confirmedAt)),
      metric("名目部位金額", plan.ok ? money(plan.notional) + " USDT" : "未達下單要求"),
      metric("每筆風險上限", money(capital * Engine.SETTINGS.riskFraction) + " USDT"));
    details.append(detailList);
    result.append(head, subtitle, prices, foot, risk, details);
    return result;
  }

  function visibleCandidates() {
    const now = Date.now() + offset;
    return candidates.filter(candidate => candidate.expiresAt > now &&
      (filter.value === "all" || candidate.direction === filter.value)).sort((a,b) => a.symbol.localeCompare(b.symbol));
  }

  function render() {
    const expanded = new Set([...list.querySelectorAll(".strategy-card")].filter(card => card.querySelector("details")?.open).map(card => card.dataset.key));
    $("riskBudget").textContent = money(capital * Engine.SETTINGS.riskFraction) + " USDT";
    const visible = visibleCandidates(), all = candidates.filter(c => c.expiresAt > Date.now() + offset);
    count.textContent = "(" + visible.length + " / " + all.length + ")";
    lastVisibleKey = visible.map(c => c.symbol + c.confirmedAt).join(",");
    list.replaceChildren();
    if (!visible.length) {
      const empty = node("div", "strategy-empty");
      empty.append(node("strong", "", busy ? "正在確認策略條件" : "目前沒有符合條件的候選"),
        node("p", "", busy ? "逐一檢查已收盤的 4H 與 15M K 線，符合條件後即顯示。" :
          completed ? "價格與均線條件需同時成立；下一根 15M K 棒收盤後自動更新。" : "請更新掃描，或等待連線恢復。"));
      list.append(empty);
    } else visible.forEach(candidate => {
      const item = card(candidate);
      if (expanded.has(item.dataset.key)) item.querySelector("details").open = true;
      list.append(item);
    });
  }

  async function run() {
    if (busy) return;
    busy = true; completed = false; candidates = [];
    currentController = new AbortController();
    refresh.disabled = true; refresh.textContent = "掃描中…";
    list.setAttribute("aria-busy", "true");
    status.textContent = "連接幣安"; status.dataset.state = "pending";
    progress.textContent = "讀取合約清單與已收盤 K 線"; meter.value = 0; meter.max = 1;
    render();
    try {
      const outcome = await client.scan({ capital, signal: currentController.signal, onProgress(state) {
        offset = state.serverOffset;
        candidates = state.candidates;
        status.textContent = "策略掃描中";
        progress.textContent = "已掃描 " + state.completed + " / " + state.total + " · 4H 趨勢成立 " + state.trending +
          (state.errors ? " · 資料不可用 " + state.errors : "");
        meter.max = state.total; meter.value = state.completed;
        if (visibleCandidates().map(c => c.symbol + c.confirmedAt).join(",") !== lastVisibleKey) render();
      } });
      candidates = outcome.candidates; completed = true;
      status.textContent = outcome.errors ? "掃描完成 · 部分資料不可用" : "掃描完成";
      status.dataset.state = outcome.errors ? "partial" : "live";
      updated.dateTime = new Date(Date.now() + offset).toISOString();
      updated.textContent = "更新於 " + time(Date.now() + offset) + "（台北）";
      nextScanAt = Math.floor(outcome.asOf / Engine.INTERVALS["15m"] + 1) * Engine.INTERVALS["15m"] + 3000;
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
    try { localStorage.setItem("codex-strategy-capital-v1", String(capital)); } catch (_) { /* optional */ }
    render();
  });
  capitalInput.addEventListener("input", () => capitalInput.setCustomValidity(""));
  capitalInput.addEventListener("input", () => {
    const value = Number(capitalInput.value);
    if (Number.isFinite(value) && value > 0) {
      capital = value;
      try { localStorage.setItem("codex-strategy-capital-v1", String(capital)); } catch (_) { /* optional */ }
      render();
    }
  });
  filter.addEventListener("change", render);
  refresh.addEventListener("click", () => { if (Date.now() >= client.getBackoffUntil()) void run(); });
  window.addEventListener("pagehide", () => currentController?.abort());
  setInterval(() => {
    if (document.visibilityState === "hidden") return;
    const key = visibleCandidates().map(c => c.symbol + c.confirmedAt).join(",");
    if (key !== lastVisibleKey) render();
    if (!busy && Date.now() + offset >= nextScanAt && navigator.onLine !== false) void run();
  }, 1000);
  void run();
})();
