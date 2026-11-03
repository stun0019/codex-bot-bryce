(function () {
  "use strict";
  const Engine = window.PaperEngine, feed = window.CatPriceFeed;
  const $ = id => document.getElementById(id), ledgerKey = "codex-paper-ledger-v1";
  const table = $("paperRows"), status = $("paperStatus"), pause = $("paperPause"), filter = $("paperFilter");
  const feeInput = $("paperFee"), slipInput = $("paperSlippage");
  let model = Engine.createModel(), isLeader = false, acquiring = false, releaseLock = null;
  let storageBlocked = false, storageMessage = "", dirty = true, changed = false, lastSave = 0;
  let currentGeneration = null, symbolsKey = "", latest = { candidates: [], capital: 70, now: Date.now() }, serverOffset = 0;
  const labels = { WAITING_PRICE: "待報價", OPEN: "持倉中", TAKE_PROFIT: "止盈", STOP_LOSS: "止損", SKIPPED: "略過", REVIEW: "待核對" };
  const money = value => Number.isFinite(value) ? value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—";
  const signed = value => Number.isFinite(value) ? (value > 0 ? "+" : "") + money(value) : "—";
  const price = value => Number.isFinite(value) ? value.toLocaleString("en-US", { maximumSignificantDigits: 10 }) : "—";
  const time = value => value ? new Date(value).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false }) : "—";
  const now = () => Date.now() + serverOffset;
  function load() {
    try { const raw = localStorage.getItem(ledgerKey); model = Engine.createModel(raw ? JSON.parse(raw) : null); }
    catch (error) { storageBlocked = true; storageMessage = "既有紀錄無法讀取，已暫停新增與覆寫；請先匯出保存。"; model = Engine.createModel(); }
    feeInput.value = String(model.settings.feeRate * 100); slipInput.value = String(model.settings.slippage * 100); dirty = true;
  }
  function save(force = false) {
    if (!isLeader || storageBlocked || (!force && (!changed || Date.now() - lastSave < 5000))) return;
    try { localStorage.setItem(ledgerKey, JSON.stringify(model.snapshot())); changed = false; lastSave = Date.now(); storageMessage = ""; }
    catch (_) { storageMessage = "本機紀錄儲存失敗，請立即匯出；關閉頁面可能遺失新紀錄。"; }
  }
  function syncSymbols() {
    if (!isLeader) return;
    const symbols = model.activeSymbols().sort(), nextKey = symbols.join(",");
    if (nextKey !== symbolsKey) { symbolsKey = nextKey; feed.setSymbols(symbols); }
  }
  function checkConnection() {
    const generation = feed.status().connections.filter(c => c.route === "market").map(c => c.openedAt).join(",");
    if (currentGeneration && generation !== currentGeneration && model.trades.some(t => t.status === "OPEN" || window.TargetEngine.pending(t))) {
      model.interrupt("行情連線已重建，期間觸價順序需核對", now()); changed = dirty = true;
    }
    currentGeneration = generation;
  }
  function ingest() {
    if (!isLeader || storageBlocked) return;
    if (model.addCandidates(latest.candidates, latest.capital, now())) { changed = dirty = true; syncSymbols(); save(true); }
  }
  window.PaperTrading = { acceptCandidates(candidates, capital, serverNow) {
    serverOffset = serverNow - Date.now(); latest = { candidates, capital, now: serverNow }; ingest();
  } };
  function node(tag, className, text) {
    const element = document.createElement(tag); if (className) element.className = className;
    if (text != null) element.textContent = text; return element;
  }
  function cell(label, value, className = "") {
    const element = node("td", className, value); element.dataset.label = label; return element;
  }
  function render() {
    if (!dirty) return; dirty = false;
    const stats = model.stats();
    window.DashboardUI?.updateSummary(stats);
    window.TargetView.stats($("paperTargets"), model.trades);
    $("paperClosed").textContent = String(stats.closed);
    $("paperOpen").textContent = stats.open + " 持倉 · " + stats.waiting + " 待報價 · " + model.trades.filter(t => window.TargetEngine.pending(t)).length + " 筆三段追蹤";
    $("paperWinRate").textContent = stats.winRate == null ? "—" : stats.winRate.toFixed(1) + "%";
    $("paperNet").textContent = signed(stats.netPnl); $("paperNet").dataset.tone = stats.netPnl >= 0 ? "positive" : "negative";
    $("paperAverage").textContent = signed(stats.averagePnl);
    $("paperDrawdown").textContent = money(stats.maxDrawdown);
    $("paperStreak").textContent = String(stats.maxLossStreak);
    $("paperBreakdown").textContent = "樣本 " + stats.closed + " 筆 · 獲利 " + stats.wins + " · 虧損 " + stats.losses +
      " · 略過 " + stats.skipped + " · 待核對 " + stats.review + "｜做多 " + stats.long.count + " 筆／" +
      (stats.long.winRate == null ? "—" : stats.long.winRate.toFixed(1) + "%") + " · 做空 " + stats.short.count + " 筆／" +
      (stats.short.winRate == null ? "—" : stats.short.winRate.toFixed(1) + "%");
    pause.disabled = !isLeader || storageBlocked; feeInput.disabled = slipInput.disabled = !isLeader || storageBlocked;
    pause.textContent = model.settings.enabled ? "暫停新增" : "恢復新增";
    const connection = feed.status().connections.some(c => c.route === "market" && c.state === WebSocket.OPEN);
    status.textContent = storageMessage || (!isLeader ? "唯讀檢視 · 由另一個分頁追蹤，或等待取得追蹤鎖" :
      model.activeSymbols().length ? connection ? "成交報價追蹤中 · 本機保存" : "連接成交報價中" :
      model.settings.enabled ? "等待新的策略候選 · 本機保存" : "已暫停新增 · 原持倉繼續追蹤");
    status.dataset.state = storageMessage ? "error" : isLeader ? "live" : "pending";
    table.replaceChildren();
    const visible = [...model.trades].reverse().filter(trade => filter.value === "all" ||
      (filter.value === "closed" ? Engine.CLOSED.has(trade.status) : filter.value === "active" ?
        trade.status === "OPEN" || trade.status === "WAITING_PRICE" || window.TargetEngine.pending(trade) : trade.status === filter.value));
    $("paperCount").textContent = "(" + visible.length + " / " + model.trades.length + ")";
    if (!visible.length) {
      const row = node("tr", "paper-empty"), td = node("td", "", model.trades.length ? "此篩選下沒有紀錄。" :
        "尚無模擬交易。新候選出現後會自動記錄；累積平倉樣本後才計算勝率。");
      td.colSpan = 10; row.append(td); table.append(row); return;
    }
    for (const trade of visible) {
      const row = node("tr", ""); row.dataset.status = trade.status;
      const identity = cell("幣種／訊號", ""); identity.append(node("strong", "", trade.symbol), node("small", "", time(trade.confirmedAt)));
      let pnl = Engine.CLOSED.has(trade.status) ? trade.netPnl : trade.status === "OPEN" ? model.netAt(trade, trade.lastPrice).net : null;
      const pnlCell = cell("淨損益 USDT", signed(pnl), "paper-pnl"); pnlCell.dataset.tone = pnl == null ? "neutral" : pnl >= 0 ? "positive" : "negative";
      if (trade.status === "OPEN") pnlCell.append(node("small", "", "未實現估算"));
      const stateCell = cell("狀態", ""); stateCell.append(node("span", "paper-badge", labels[trade.status]));
      const reason = cell("說明／成交時間", ""); reason.append(node("span", "", trade.reason + " · 原出場目標 " + price(trade.target)),
        node("small", "", trade.closedAt ? "出場 " + time(trade.closedAt) : trade.openedAt ? "進場 " + time(trade.openedAt) : "發現 " + time(trade.detectedAt)));
      const targetCell = cell("TP1／TP2／TP3", ""); targetCell.append(window.TargetView.detail(trade));
      if (window.TargetEngine.pending(trade)) stateCell.append(node("small", "", "三段目標繼續追蹤"));
      row.append(identity, cell("方向", trade.direction === "LONG" ? "做多" : "做空"), cell("模擬進場", price(trade.entry)),
        cell("停損", price(trade.stopLoss)), targetCell, cell("數量", price(trade.quantity)),
        cell("出場價", price(trade.exit)), stateCell, pnlCell, reason); table.append(row);
    }
  }
  async function acquire() {
    if (isLeader || acquiring || storageBlocked) return;
    if (!navigator.locks) { storageMessage = "請以支援 Web Locks 的 HTTPS／localhost 頁面啟用單分頁追蹤。"; dirty = true; return; }
    acquiring = true;
    try {
      await navigator.locks.request("codex-paper-tracker-v1", { ifAvailable: true }, async lock => {
        acquiring = false; if (!lock) return;
        load(); if (storageBlocked) return;
        isLeader = true; currentGeneration = null;
        model.interrupt("重新開啟頁面，離線期間觸價順序需核對", now()); changed = dirty = true; save(true);
        ingest(); syncSymbols(); render();
        await new Promise(resolve => { releaseLock = resolve; });
        releaseLock = null; isLeader = false;
      });
    } catch (_) { acquiring = false; storageMessage = "無法取得追蹤鎖，已停用自動新增。"; dirty = true; }
  }
  load();
  feed.subscribeTicks(quote => {
    if (!isLeader || quote.source !== "ws") return;
    checkConnection();
    const symbol = quote.pair.replace("-USDT", "USDT");
    if (model.tick(symbol, quote.price, quote.timestamp)) {
      changed = dirty = true;
      if (model.trades.some(t => t.openedAt === quote.timestamp || t.closedAt === quote.timestamp)) save(true);
    }
  });
  pause.addEventListener("click", () => {
    if (!isLeader || storageBlocked) return;
    model.settings.enabled = !model.settings.enabled; changed = dirty = true; save(true); render();
    if (model.settings.enabled) ingest();
  });
  function updateAssumptions() {
    if (!isLeader || storageBlocked) return;
    const fee = Number(feeInput.value), slip = Number(slipInput.value);
    if (![fee, slip].every(value => Number.isFinite(value) && value >= 0 && value <= 1) || !feeInput.value || !slipInput.value) {
      $("paperSettingsMessage").textContent = "請輸入 0～1% 的模擬費率／滑價。"; return;
    }
    model.settings.feeRate = fee / 100; model.settings.slippage = slip / 100;
    $("paperSettingsMessage").textContent = "已更新，僅套用於之後新增的訊號。"; changed = dirty = true; save(true);
  }
  feeInput.addEventListener("change", updateAssumptions); slipInput.addEventListener("change", updateAssumptions);
  filter.addEventListener("change", () => { dirty = true; render(); });
  $("paperExport").addEventListener("click", () => {
    const payload = storageBlocked ? localStorage.getItem(ledgerKey) : JSON.stringify({ ...model.snapshot(),
      exportedAt: new Date().toISOString(), mode: "independent-forward-paper-trades", stats: model.stats() }, null, 2);
    const url = URL.createObjectURL(new Blob([payload || ""], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "codex-paper-trades-" +
      new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" }) + ".json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  window.addEventListener("storage", event => { if (event.key === ledgerKey && !isLeader) { load(); render(); } });
  window.addEventListener("offline", () => {
    if (isLeader && model.interrupt("網路中斷，期間觸價順序需核對", now())) { changed = dirty = true; save(true); syncSymbols(); render(); }
  });
  window.addEventListener("pagehide", () => {
    if (isLeader) { model.interrupt("頁面已離開，離線期間需核對", now()); changed = true; save(true); }
    releaseLock?.();
  });
  setInterval(() => {
    if (!isLeader) { void acquire(); render(); return; }
    checkConnection();
    if (model.expire(now())) changed = dirty = true;
    syncSymbols(); save(); render();
  }, 1000);
  render(); void acquire();
})();
