(function () {
  "use strict";
  const Engine = window.PaperEngine, feed = window.CatPriceFeed;
  const $ = id => document.getElementById(id), ledgerKey = "codex-paper-ledger-v1";
  const table = $("paperRows"), status = $("paperStatus"), pause = $("paperPause"), filter = $("paperFilter");
  const feeInput = $("paperFee"), slipInput = $("paperSlippage");
  let model = Engine.createModel(), isLeader = false, acquiring = false, releaseLock = null;
  let storageBlocked = false, storageMessage = "", dirty = true, changed = false, lastSave = 0;
  let currentGeneration = null, symbolsKey = "", latest = { candidates: [], capital: 200, now: Date.now(), committed: false }, serverOffset = 0;
  let coordinator = null, recoveryController = null, recoveryProgress = "";
  const recoveryClient = window.PaperRecovery.createClient({ clock: () => now() });
  const labels = { NOT_ENTERED:"未進場", WAITING_PRICE: "待報價", OPEN: "持倉中", TAKE_PROFIT: "止盈", STOP_LOSS: "止損", SKIPPED: "略過", REVIEW: "待核對" };
  const money = value => Number.isFinite(value) ? value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—";
  const signed = value => Number.isFinite(value) ? (value > 0 ? "+" : "") + money(value) : "—";
  const price = value => Number.isFinite(value) ? value.toLocaleString("en-US", { maximumSignificantDigits: 10 }) : "—";
  const time = value => value ? new Date(value).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false }) : "—";
  const now = () => Date.now() + serverOffset;
  function load(activateAccount = false) {
    recoveryController?.abort(); recoveryController = null;
    try { const raw = localStorage.getItem(ledgerKey); model = Engine.createModel(raw ? JSON.parse(raw) : null); }
    catch (error) { storageBlocked = true; storageMessage = "既有紀錄無法讀取，已暫停新增與覆寫；請先匯出保存。"; model = Engine.createModel(); }
    if (activateAccount && !storageBlocked) model.enableAccount(200, now());
    coordinator = window.PaperRecovery.createCoordinator({ model, client: recoveryClient, clock: now,
      onChange(force) { changed = dirty = true; if (force) save(true); },
      onProgress(progress) { recoveryProgress = "核對 " + progress.symbol + " · " + progress.rows + " 筆成交"; dirty = true; } });
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
      model.suspend("行情連線已重建，期間觸價順序需核對", now()); changed = dirty = true;
    }
    currentGeneration = generation;
  }
  async function pumpRecovery() {
    if (!isLeader || storageBlocked || navigator.onLine === false || coordinator?.running || !model.recoveryTasks(now()).length) return;
    if (!recoveryController || recoveryController.signal.aborted) recoveryController = new AbortController();
    try { await coordinator.recover(recoveryController.signal); }
    catch (error) { if (error.name !== "AbortError") { recoveryProgress = "核對暫停：" + error.message; dirty = true; } }
    finally { recoveryProgress = ""; dirty = true; }
  }
  function ingest() {
    if (!isLeader || storageBlocked || !latest.committed) return;
    if (model.addCandidates(latest.candidates, latest.capital, now())) { changed = dirty = true; syncSymbols(); save(true); }
  }
  window.PaperTrading = {
    recordStatus(candidate) { const t=model.trades.find(t=>t.id===Engine.key(candidate)); return t?{status:t.status,entered:!!t.entry,recovering:!!t.recovery?.pending,reason:t.reason,quantity:t.quantity,estimatedStopRisk:t.estimatedStopRisk,remainingQuantity:t.remainingQuantity,netPnl:t.netPnl}:null; },
    invalidatePending(reason) { latest.committed=false; if (!isLeader || storageBlocked) return; let count=0; for (const trade of model.trades) if (trade.status==="WAITING_PRICE") { model.cancelOrder(trade,reason,now()); count++; } if(count) {changed=dirty=true;syncSymbols();save(true);render();} },
    accountState() { return model.accountState(now()); },
    beginScan() { latest = { ...latest, candidates: [], committed: false }; },
    previewCandidates(candidates, capital) {
      if (storageBlocked) return new Map(candidates.map(c => [Engine.key(c), { ok: false, reason: storageMessage }]));
      if (!model.accountSnapshot()) return new Map(candidates.map(c => [Engine.key(c), { ok: false, reason: "等待共用帳戶初始化" }]));
      const plans = model.previewCandidates(candidates, capital, now());
      if (!isLeader) for (const [key, plan] of plans) if (!plan.status) plans.set(key, { ...plan, ok: false, reason: "唯讀分頁，等待負責追蹤的分頁預留" });
      return plans;
    }, reconcileCandidates(candidates, observations, at) { if (isLeader && !storageBlocked && model.reconcileCandidates(candidates, observations, at)) { changed = dirty = true; syncSymbols(); save(true); render(); } }, acceptCandidates(candidates, capital, serverNow, commit = false) {
    serverOffset = serverNow - Date.now(); latest = { candidates, capital, now: serverNow, committed: commit }; if (commit) { ingest(); dirty=true; render(); }
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
    const account = model.accountState(now());
    const values = { accountBalance: account?.balance, accountEquity: account?.equity, accountAvailable: account?.availableMargin, accountRisk: account?.usedRisk, accountLongRisk: account?.directions.LONG.risk, accountShortRisk: account?.directions.SHORT.risk, accountPeriodPnl: account?.periodPnl, accountMargin: account ? account.positionMargin + account.orderMargin + account.feeReserve : null };
    for (const [id, value] of Object.entries(values)) $(id).textContent = money(value);
    $("accountRiskCap").textContent = account ? "上限 " + money(account.totalLimit) + " USDT · 5%" : "總風險上限 5%";
    $("accountStatus").textContent = storageMessage || (account ? account.blockedReason || (isLeader ? "共用模擬帳戶 · 風控正常" : "共用模擬帳戶 · 另一分頁負責追蹤") : "等待取得追蹤鎖並初始化共用帳戶");
    $("accountStatus").dataset.state = account?.blockedReason || storageBlocked ? "error" : "live";
    $("accountMarginDetail").textContent = account ? "持倉保證金 " + money(account.positionMargin) + " · 待成交保證金 " + money(account.orderMargin) + " · 預估費用預留 " + money(account.feeReserve) + " USDT；名目部位上限 " + account.limits.leverage + "x。" : "";
    $("accountStarted").textContent = account ? "起算 " + time(account.startedAt) + " · 初始餘額 " + money(account.initialCapital) + " · 起算淨值 " + money(account.startingEquity) + " USDT；既有持倉已納入風控。" : "";
    window.dispatchEvent(new Event("paper-account-update"));
    const profileId=$("paperTimeframe").value,ema=window.EmaEngine.isVersion;
    const match=t=>profileId==="all"||(profileId==="ema"?ema(t.strategyVersion):profileId==="previous"?!ema(t.strategyVersion):profileId.startsWith("ema:")&&ema(t.strategyVersion)&&t.profileId===profileId.slice(4));
    const records=window.CandidateRecords.create({getItem:key=>localStorage.getItem(key),setItem:(key,value)=>localStorage.setItem(key,value)}).list();
    const currentKeys=new Set(latest.committed?latest.candidates.map(Engine.key):[]),plans=model.previewCandidates(latest.committed?latest.candidates:[],latest.capital,now());
    const display=window.CandidateRecords.paperRows(records,model.trades,{now:now(),currentKeys,plans});
    const cohort=model.trades.filter(match),displayCohort=display.filter(match);
    const stats = model.stats(profileId);
    window.DashboardUI?.updateSummary(model.stats("ema"));
    window.TargetView.stats($("paperTargets"), cohort);
    window.TargetView.paperSummary($("paperSummary"), {account,stats,trades:cohort});
    $("paperClosed").textContent = String(stats.closed);
    $("paperOpen").textContent = stats.open + " 持倉 · " + stats.waiting + " 待報價 · " + stats.recovering + " 核對中 · " + model.trades.filter(t => window.TargetEngine.pending(t)).length + " 筆目標追蹤";
    $("paperWinRate").textContent = stats.winRate == null ? "—" : stats.winRate.toFixed(1) + "%";
    $("paperNet").textContent = signed(stats.netPnl); $("paperNet").dataset.tone = stats.netPnl >= 0 ? "positive" : "negative";
    $("paperAverage").textContent = signed(stats.averagePnl);
    $("paperDrawdown").textContent = money(stats.maxDrawdown);
    $("paperStreak").textContent = String(stats.maxLossStreak);
    $("paperBreakdown").textContent = "樣本 " + stats.closed + " 筆 · 獲利 " + stats.wins + " · 虧損 " + stats.losses +
      " · 略過 " + stats.skipped + " · 待核對 " + stats.review + "｜做多 " + stats.long.count + " 筆／" +
      (stats.long.winRate == null ? "—" : stats.long.winRate.toFixed(1) + "%") + " · 做空 " + stats.short.count + " 筆／" +
      (stats.short.winRate == null ? "—" : stats.short.winRate.toFixed(1) + "%");
    $("paperRecoverySummary").textContent = "連續追蹤平倉 " + stats.continuousClosed + " · 補查確認平倉 " + stats.reconciledClosed + " · 核對中 " + stats.recovering + (stats.legacyReview ? " · 舊版缺少成交編號 " + stats.legacyReview + " 筆保留待核對" : "");
    $("paperRecover").disabled = !isLeader || storageBlocked || coordinator?.running || !model.trades.some(t => t.recovery?.pending || (t.recovery?.state === "REVIEW" && t.checkpoint));
    $("paperClear").disabled = !isLeader || storageBlocked || !display.length;
    pause.disabled = !isLeader || storageBlocked; feeInput.disabled = slipInput.disabled = !isLeader || storageBlocked;
    pause.textContent = model.settings.enabled ? "暫停新增" : "恢復新增";
    const connection = feed.status().connections.some(c => c.route === "market" && c.state === WebSocket.OPEN);
    status.textContent = storageMessage || (isLeader && stats.recovering ? (recoveryProgress || "等待補查中斷行情，確認後自動恢復") : "") || (!isLeader ? "唯讀檢視 · 由另一個分頁追蹤，或等待取得追蹤鎖" :
      model.activeSymbols().length ? connection ? "成交報價追蹤中 · 本機保存" : "連接成交報價中" :
      model.settings.enabled ? "等待新的策略候選 · 本機保存" : "已暫停新增 · 原持倉繼續追蹤");
    status.dataset.state = storageMessage ? "error" : isLeader ? "live" : "pending";
    const expanded = new Set([...table.querySelectorAll("tr[data-key]")].filter(row => row.querySelector("details")?.open).map(row => row.dataset.key));
    table.replaceChildren();
    const visible = [...displayCohort].reverse().filter(trade => filter.value === "all" || (filter.value === "RECOVERING" && trade.recovery?.pending) || (filter.value === "REVIEW" && trade.targets?.some(t => t.status === "REVIEW")) ||
      (filter.value === "closed" ? Engine.CLOSED.has(trade.status) : filter.value === "active" ?
        trade.status === "OPEN" || trade.status === "WAITING_PRICE" || window.TargetEngine.pending(trade) : trade.status === filter.value));
    $("paperCount").textContent = "(" + visible.length + " / " + display.length + ")";
    if (!visible.length) {
      const row = node("tr", "paper-empty"), td = node("td", "", display.length ? "此篩選下沒有紀錄。" :
        "尚無模擬交易。新候選出現後會自動記錄；累積平倉樣本後才計算勝率。");
      td.colSpan = 10; row.append(td); table.append(row); return;
    }
    for (const trade of visible) {
      const row = node("tr", ""); row.dataset.status = trade.status; row.dataset.key = trade.id;
      const identity = cell("幣種／訊號", ""); identity.append(node("strong", "", trade.symbol), node("span", "strategy-timeframe", trade.timeframeLabel ? (ema(trade.strategyVersion)?"EMA · ":"SMC · ") + trade.timeframeLabel : "舊策略／未標示週期"), node("small", "", time(trade.confirmedAt)));
      let pnl = Engine.CLOSED.has(trade.status) ? trade.netPnl : trade.status === "OPEN" && !trade.recovery?.pending ? model.netAt(trade, trade.lastPrice).net : null;
      const pnlCell = cell("淨損益 USDT", signed(pnl), "paper-pnl"); pnlCell.dataset.tone = pnl == null ? "neutral" : pnl >= 0 ? "positive" : "negative";
      if (trade.status === "OPEN" && !trade.recovery?.pending) pnlCell.append(node("small", "", "未實現估算"));
      const stateCell = cell("狀態", ""); stateCell.append(node("span", "paper-badge", trade.recovery?.pending && trade.status === "OPEN" ? "核對中" : labels[trade.status]));
      const reason = cell("", ""), explanation = node("details", "card-explanation");
      explanation.append(node("summary", "", "詳細資訊"), node("p", "", (trade.recovery?.pending ? trade.recovery.lastError || trade.recovery.reason : trade.reason) + (trade.recovery?.recovered ? " · 已核對至 " + time(trade.recovery.lastVerifiedAt) : "") + " · TP1 基準 " + price(trade.target)),
        node("small", "", trade.closedAt ? "出場 " + time(trade.closedAt) : trade.openedAt ? "進場 " + time(trade.openedAt) : "發現 " + time(trade.detectedAt)));
      if (trade.exitFills) explanation.append(node("p", "", "已出場：" + (trade.exitFills.map(f => f.label + " " + price(f.quantity) + " @ " + price(f.price)).join("；") || "尚無") + " · 初始部位 " + price(trade.quantity)));
      explanation.open = expanded.has(trade.id); reason.append(explanation);
      const targetCell = cell("TP1／TP2／TP3", ""); targetCell.append(window.TargetView.detail(trade));
      if (trade.recovery?.recovered && !trade.recovery.pending && trade.status === "OPEN") stateCell.append(node("small", "", "已核對恢復"));
      if (window.TargetEngine.pending(trade)) stateCell.append(node("small", "", trade.recovery?.pending ? "目標核對中" : "目標繼續追蹤"));
      row.append(identity, cell("方向", trade.direction === "LONG" ? "做多" : "做空"), cell("模擬進場", price(trade.entry)),
        cell("停損", price(trade.stopLoss)), targetCell, cell(trade.partialExit ? "剩餘／初始數量" : "數量", trade.partialExit && trade.quantity ? price(trade.remainingQuantity) + " / " + price(trade.quantity) : price(trade.quantity)),
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
        load(true); if (storageBlocked) return;
        isLeader = true; currentGeneration = null;
        model.suspend("重新開啟頁面，離線期間觸價順序需核對", now()); changed = dirty = true; save(true);
        recoveryController = new AbortController();
        ingest(); syncSymbols(); render(); void pumpRecovery();
        await new Promise(resolve => { releaseLock = resolve; });
        releaseLock = null; isLeader = false;
      });
    } catch (_) { acquiring = false; storageMessage = "無法取得追蹤鎖，已停用自動新增。"; dirty = true; }
  }
  load();
  feed.subscribeTicks(quote => {
    if (!isLeader || storageBlocked || quote.source !== "ws") return;
    checkConnection();
    if (coordinator.accept(quote)) {
      changed = dirty = true;
      if (model.trades.some(t => t.openedAt === quote.timestamp || t.closedAt === quote.timestamp || t.targets?.some(target => target.at === quote.timestamp))) save(true);
      if (model.recoveryTasks(now()).length) { save(true); void pumpRecovery(); }
    }
  });
  $("paperRecover").addEventListener("click", () => {
    if (!isLeader || storageBlocked) return;
    if (model.retryRecovery(now())) { changed = dirty = true; save(true); syncSymbols(); render(); void pumpRecovery(); }
  });
  $("paperClear").addEventListener("click", () => {
    if (!isLeader || storageBlocked) return;
    if (!window.confirm("清空此瀏覽器全部模擬交易與持倉紀錄，並將共用模擬帳戶重設為初始資金？此操作無法還原。費率設定會保留。")) return;
    const next = Engine.createModel({ version: 1, settings: { ...model.settings }, trades: [], ignoreBefore: now() });
    const currentAccount = model.accountSnapshot(); next.enableAccount(currentAccount?.initialCapital || 200, now(), currentAccount?.limits || window.AccountRisk.DEFAULTS);
    try { localStorage.setItem(ledgerKey, JSON.stringify(next.snapshot())); }
    catch (_) { storageMessage = "清空失敗，原有紀錄仍保留。"; dirty = true; render(); return; }
    window.dispatchEvent(new Event("paper-records-cleared"));
    load(); latest = { candidates: [], capital: latest.capital, now: now(), committed: false }; currentGeneration = null; recoveryProgress = "";
    changed = dirty = true; syncSymbols(); save(true); render();
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
  $("paperTimeframe").addEventListener("change", () => { dirty = true; render(); });
  $("paperExport").addEventListener("click", () => {
    const payload = storageBlocked ? localStorage.getItem(ledgerKey) : JSON.stringify({ ...model.snapshot(),
      exportedAt: new Date().toISOString(), mode: "shared-account-forward-paper-trades", stats: model.stats() }, null, 2);
    const url = URL.createObjectURL(new Blob([payload || ""], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "codex-paper-trades-" +
      new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" }) + ".json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  window.addEventListener("candidate-records-update",()=>{dirty=true;render();});
  window.addEventListener("storage",event=>{if(event.key===window.CandidateRecords.KEY){dirty=true;render();}else if(event.key===ledgerKey&&!isLeader){load();render();}});
  window.addEventListener("online", () => { if (isLeader) void pumpRecovery(); });
  window.addEventListener("offline", () => {
    recoveryController?.abort();
    if (isLeader && model.suspend("網路中斷，期間觸價順序需核對", now())) { changed = dirty = true; save(true); syncSymbols(); render(); }
  });
  window.addEventListener("pagehide", () => {
    recoveryController?.abort();
    if (isLeader) { model.suspend("頁面已離開，離線期間需核對", now()); changed = true; save(true); }
    releaseLock?.();
  });
  setInterval(() => {
    if (!isLeader) { void acquire(); render(); return; }
    checkConnection();
    if (model.expire(now())) changed = dirty = true;
    ingest(); syncSymbols(); save(); render(); void pumpRecovery();
  }, 1000);
  render(); void acquire();
})();
