(function () {
  "use strict";
  const Engine = window.PaperEngine, feed = window.CatPriceFeed;
  const $ = id => document.getElementById(id), ledgerKey = "codex-paper-smc-2r-ledger-v1";
  const table = $("paperRows"), status = $("paperStatus"), pause = $("paperPause"), filter = $("paperFilter");
  const feeInput = $("paperFee"), slipInput = $("paperSlippage");
  let model = Engine.createModel(), isLeader = false, acquiring = false, releaseLock = null;
  let storageBlocked = false, storageMessage = "", dirty = true, changed = false, lastSave = 0;
  let currentGeneration = null, symbolsKey = "", latest = { candidates: [], capital: 100, now: Date.now(), committed: false }, serverOffset = 0;
  let coordinator = null, recoveryController = null, recoveryProgress = "";
  const recoveryClient = window.PaperRecovery.createClient({ clock: () => now() });
  const labels = { NOT_ENTERED:"未進場", WAITING_PRICE: "待報價", OPEN: "持倉中", TAKE_PROFIT: "止盈", STOP_LOSS: "止損", TIME_EXIT:"時間平倉", SKIPPED: "略過", REVIEW: "待核對" };
  const money = value => Number.isFinite(value) ? value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—";
  const signed = value => Number.isFinite(value) ? (value > 0 ? "+" : "") + money(value) : "—";
  const price = value => Number.isFinite(value) ? value.toLocaleString("en-US", { maximumSignificantDigits: 10 }) : "—";
  const time = value => value ? new Date(value).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false }) : "—";
  const now = () => Date.now() + serverOffset;
  function load(activateAccount = false) {
    recoveryController?.abort(); recoveryController = null;
    try { const raw = localStorage.getItem(ledgerKey); model = Engine.createModel(raw ? JSON.parse(raw) : null); if(window.MacdStrategy.MODE==='CANDIDATES_ONLY')for(const t of model.trades)if(t.status==='WAITING_PRICE')model.cancelOrder(t,'已改為主觀進場，不再自動成交',now()); }
    catch (error) { storageBlocked = true; storageMessage = "既有紀錄無法讀取，已暫停新增與覆寫；請先匯出保存。"; model = Engine.createModel(); }
    if (activateAccount && !storageBlocked) {model.enableAccount(100, now());model.startStrategySession(100,now());}
    coordinator = window.PaperRecovery.createCoordinator({ model, client: recoveryClient, clock: now,
      onChange(force) { changed = dirty = true; if (force) save(true); },
      onProgress(progress) { recoveryProgress = "核對 " + progress.symbol + " · " + progress.rows + " 筆成交"; dirty = true; } });
    feeInput.value = String(model.settings.feeRate * 100); slipInput.value = String(model.settings.slippage * 100); dirty = true;
  }
  let fundingBusy=false,lastFundingAt=0;
  async function syncFunding(){
    if(!isLeader||storageBlocked||fundingBusy||document.visibilityState==='hidden'||navigator.onLine===false||Date.now()-lastFundingAt<60000)return;
    const cohort=model.trades.filter(t=>window.SmcEntry.isIntraday(t)&&t.openedAt&&(!t.closedAt||!t.fundingCheckedAt||t.fundingCheckedAt<t.closedAt));
    if(!cohort.length)return;fundingBusy=true;lastFundingAt=Date.now();
    try{for(const symbol of [...new Set(cohort.map(t=>t.symbol))]){
      let from=Math.min(...cohort.filter(t=>t.symbol===symbol).map(t=>t.openedAt)),checkedAt=now(),rows=[];
      while(from<=checkedAt){const response=await fetch('https://fapi.binance.com/fapi/v1/fundingRate?symbol='+encodeURIComponent(symbol)+'&startTime='+from+'&endTime='+Math.floor(checkedAt)+'&limit=1000',{signal:AbortSignal.timeout(10000),cache:'no-store'});if(!response.ok)throw Error('HTTP '+response.status);const page=await response.json();if(!Array.isArray(page))throw Error('回應格式錯誤');rows.push(...page);if(page.length<1000)break;const next=Number(page.at(-1).fundingTime)+1;if(!(next>from))throw Error('資金費率分頁錯誤');from=next;}
      model.applyFunding(symbol,rows,checkedAt);changed=dirty=true;save(true);
    }$('paperFundingStatus').textContent='資金費率已同步 · '+time(now());}
    catch(error){$('paperFundingStatus').textContent='資金費率待核對：'+error.message;}
    finally{fundingBusy=false;}
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
    if (!isLeader || storageBlocked || !latest.committed || document.visibilityState==='hidden') return;
    if (model.addCandidates(latest.candidates, latest.capital, now())) { changed = dirty = true; syncSymbols(); save(true); }
  }
  window.PaperTrading = {
    updateMarketContext(observations){let updated=false;for(const t of model.trades){const o=observations.find(o=>o.symbol===t.symbol&&o.status!=='ERROR');if(o){t.macdDivergence=o.divergence?JSON.parse(JSON.stringify(o.divergence)):null;t.latestMacd=o.emaTrend;updated=true;}}if(updated){dirty=changed=true;save(true);render();}},
    marketSymbols(){return model.activeSymbols();},
    recordedZecPosition(){
      const candidate = window.ZecRecordedFill;
      if (!candidate) return null;
      return model.trades.find(trade => trade.id === Engine.key(candidate) && trade.status === "OPEN") ?? null;
    },
    cardSnapshot(candidate){const t=model.trades.find(t=>t.id===Engine.key(candidate));if(!t)return null;return {...JSON.parse(JSON.stringify(t)),cardPnl:Engine.CLOSED.has(t.status)?t.netPnl:t.status==="OPEN"&&!t.recovery?.pending&&Number.isFinite(t.lastPrice)?model.netAt(t,t.lastPrice).net:null};},
    recordStatus(candidate) { const t=model.trades.find(t=>t.id===Engine.key(candidate)); return t?{status:t.status,entered:!!t.entry,recovering:!!t.recovery?.pending,reason:t.reason,quantity:t.quantity,estimatedStopRisk:t.estimatedStopRisk,remainingQuantity:t.remainingQuantity,exitGuard:t.exitGuard?{...t.exitGuard}:null,netPnl:t.netPnl}:null; },
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
  function summaryAccount(account,cohort){if(!account)return null;const pnl=cohort.reduce((s,t)=>s+(Engine.CLOSED.has(t.status)?t.netPnl:t.status==='OPEN'&&!t.recovery?.pending&&Number.isFinite(t.lastPrice)?model.netAt(t,t.lastPrice).net:0),0),unknown=cohort.some(t=>t.recovery?.pending||t.status==='REVIEW'||t.status==='OPEN'&&!Number.isFinite(t.lastPrice));return {...account,periodPnl:pnl,returnPct:unknown?null:100*pnl/account.initialCapital};}
  function render() {
    if (!dirty) return; dirty = false;
    const account = model.accountState(now());
    const values = { accountBalance: account?.balance, accountEquity: account?.equity, accountAvailable: account?.availableMargin, accountRisk: account?.usedRisk, accountLongRisk: account?.directions.LONG.risk, accountShortRisk: account?.directions.SHORT.risk, accountPeriodPnl: account?.periodPnl, accountMargin: account ? account.positionMargin + account.orderMargin + account.feeReserve : null };
    for (const [id, value] of Object.entries(values)) $(id).textContent = money(value);
    $("accountRiskCap").textContent = account ? "上限 " + money(account.totalLimit) + " USDT · 5%" : "總風險上限 5%";
    $("accountStatus").textContent = storageMessage || account?.blockedReason || "";
    $("accountStatus").hidden = !$("accountStatus").textContent;
    $("accountStatus").dataset.state = account?.blockedReason || storageBlocked ? "error" : "live";
    $("accountMarginDetail").textContent = account ? "持倉保證金 " + money(account.positionMargin) + " · 待成交保證金 " + money(account.orderMargin) + " · 預估費用預留 " + money(account.feeReserve) + " USDT；名目部位上限 " + account.limits.leverage + "x。" : "";
    $("accountStarted").textContent = account ? "起算 " + time(account.startedAt) + " · 初始餘額 " + money(account.initialCapital) + " · 起算淨值 " + money(account.startingEquity) + " USDT；既有持倉已納入風控。" : "";
    window.dispatchEvent(new Event("paper-account-update"));
    const records=window.CandidateRecords.create({getItem:key=>localStorage.getItem(key),setItem:(key,value)=>localStorage.setItem(key,value)}).list();
    const display = model.trades.filter(trade => window.SmcEntry.isSingle(trade) && Number.isFinite(trade.entry) && trade.entry > 0);
    const cohort = display.filter(trade => window.MacdStrategy.isVersion(trade.strategyVersion));
    const stats = model.stats("current");
    window.DashboardUI?.updateSummary(model.stats("current"));
    window.TargetView.stats($("paperTargets"), cohort, {targetMode:"SINGLE"});
    window.TargetView.paperSummary($("paperSummary"), {account: summaryAccount(account,cohort),stats,trades:cohort});
    $("paperClosed").textContent = String(stats.closed);
    $("paperOpen").textContent = stats.open + " 持倉 · " + stats.recovering + " 核對中 · " + model.trades.filter(t => window.TargetEngine.pending(t)).length + " 筆目標追蹤";
    $("paperWinRate").textContent = stats.winRate == null ? "—" : stats.winRate.toFixed(1) + "%";
    $("paperNet").textContent = signed(stats.netPnl); $("paperNet").dataset.tone = stats.netPnl >= 0 ? "positive" : "negative";
    $("paperAverage").textContent = signed(stats.averagePnl);
    $("paperDrawdown").textContent = money(stats.maxDrawdown);
    $("paperStreak").textContent = String(stats.maxLossStreak);
    $("paperBreakdown").textContent = "樣本 " + stats.closed + " 筆 · 獲利 " + stats.wins + " · 虧損 " + stats.losses +
      " · 待核對 " + stats.review + "｜做多 " + stats.long.count + " 筆／" +
      (stats.long.winRate == null ? "—" : stats.long.winRate.toFixed(1) + "%") + " · 做空 " + stats.short.count + " 筆／" +
      (stats.short.winRate == null ? "—" : stats.short.winRate.toFixed(1) + "%");
    $("paperRecoverySummary").textContent = "連續追蹤平倉 " + stats.continuousClosed + " · 補查確認平倉 " + stats.reconciledClosed + " · 核對中 " + stats.recovering + (stats.legacyReview ? " · 舊版缺少成交編號 " + stats.legacyReview + " 筆保留待核對" : "");
    $("paperRecover").disabled = !isLeader || storageBlocked || coordinator?.running || !model.trades.some(t => t.recovery?.pending || (t.recovery?.state === "REVIEW" && t.checkpoint));
    $("paperClear").disabled = !isLeader || storageBlocked || (!model.trades.length && !records.length);
    pause.disabled = window.MacdStrategy.MODE==='CANDIDATES_ONLY' || !isLeader || storageBlocked; feeInput.disabled = slipInput.disabled = !isLeader || storageBlocked;
    pause.textContent = window.MacdStrategy.MODE==='CANDIDATES_ONLY'?'已停用自動新增':model.settings.enabled ? "暫停新增" : "恢復新增";
    const connection = feed.status().connections.some(c => c.route === "market" && c.state === WebSocket.OPEN);
    status.textContent = storageMessage || (isLeader && stats.recovering ? (recoveryProgress || "等待補查中斷行情，確認後自動恢復") : "") || (!isLeader ? "唯讀檢視 · 由另一個分頁追蹤，或等待取得追蹤鎖" :
      model.activeSymbols().length ? connection ? "成交報價追蹤中 · 本機保存" : "連接成交報價中" :
      model.settings.enabled ? "等待新的策略候選 · 本機保存" : "已暫停新增 · 原持倉繼續追蹤");
    status.dataset.state = storageMessage ? "error" : isLeader ? "live" : "pending";
    const expanded = new Set([...table.querySelectorAll("tr[data-key]")].filter(row => row.querySelector("details")?.open).map(row => row.dataset.key));
    table.replaceChildren();
    const visible = [...display].reverse().filter(trade => filter.value === "all" || (filter.value === "RECOVERING" && trade.recovery?.pending) || (filter.value === "REVIEW" && trade.targets?.some(t => t.status === "REVIEW")) ||
      (filter.value === "closed" ? Engine.CLOSED.has(trade.status) : filter.value === "active" ?
        trade.status === "OPEN" : trade.status === filter.value));
    $("paperCount").textContent = "(" + visible.length + " / " + display.length + ")";
    window.TradeCards.paper($("paperCards"),visible,model,now());
    if (!visible.length) {
      const row = node("tr", "paper-empty"), td = node("td", "", display.length ? "此篩選下沒有紀錄。" :
        "尚無模擬交易。成交後會自動顯示；累積平倉樣本後才計算勝率。");
      td.colSpan = 10; row.append(td); table.append(row); return;
    }
    for (const trade of visible) {
      const row = node("tr", ""); row.dataset.status = trade.status; row.dataset.exit=trade.exitReason||""; row.dataset.targetMode=trade.targetMode||"R"; row.dataset.key = trade.id;
      const identity = cell("幣種／訊號", ""); identity.append(node("strong", "", trade.symbol), node("span", "strategy-timeframe", trade.timeframeLabel ? (trade.strategyName||'舊策略')+' · ' + trade.timeframeLabel : (trade.strategyName||'舊策略')), node("small", "", time(trade.confirmedAt)));
      let pnl = Engine.CLOSED.has(trade.status) ? trade.netPnl : trade.status === "OPEN" && !trade.recovery?.pending ? model.netAt(trade, trade.lastPrice).net : null;
      const pnlCell = cell("淨損益 USDT", signed(pnl), "paper-pnl"); pnlCell.dataset.tone = pnl == null ? "neutral" : pnl >= 0 ? "positive" : "negative";
      if (trade.status === "OPEN" && !trade.recovery?.pending) pnlCell.append(node("small", "", "未實現估算"));
      const stateCell = cell("狀態", ""), statusLine=node("div","paper-status-line");
      statusLine.append(node("span", "paper-badge", trade.recovery?.pending && trade.status === "OPEN" ? "核對中" : trade.exitReason?.startsWith("RETRACE_")?"回撤出場":labels[trade.status]));
      if(trade.status==="WAITING_PRICE"){
        const quote=trade.checkpoint,age=now()-quote?.at;
        const fresh=Number.isFinite(quote?.price)&&quote.price>0&&Number.isFinite(age)&&age>=0&&age<=Engine.MAX_GAP_MS;
        const current=node("span","paper-current-price");current.dataset.state=fresh?"live":"pending";
        current.append(node("small","","現價"),node("strong","",fresh?price(quote.price):"—"));
        current.title=fresh?"Binance 最新已接收成交價 · "+time(quote.at):"等待新的 Binance 成交報價";
        statusLine.append(current);
      }
      stateCell.append(statusLine);
      const reason = cell("", ""), explanation = node("details", "card-explanation");
      explanation.append(node("summary", "", "詳細資訊"), node("p", "", (trade.recovery?.pending ? trade.recovery.lastError || trade.recovery.reason : trade.reason) + (trade.recovery?.recovered ? " · 已核對至 " + time(trade.recovery.lastVerifiedAt) : "") + " · TP1 基準 " + price(trade.target)+" · 單一結構目標全部出場"),
        node("small", "", trade.closedAt ? "出場 " + time(trade.closedAt) : trade.openedAt ? "進場 " + time(trade.openedAt) : "發現 " + time(trade.detectedAt)));
      if (trade.exitFills) explanation.append(node("p", "", "已出場：" + (trade.exitFills.map(f => f.label + " " + price(f.quantity) + " @ " + price(f.price)).join("；") || "尚無") + " · 初始部位 " + price(trade.quantity)));
      explanation.open = expanded.has(trade.id); reason.append(explanation);
      const targetCell = cell("結構目標", ""); targetCell.append(window.TargetView.detail(trade));
      if (trade.recovery?.recovered && !trade.recovery.pending && trade.status === "OPEN") stateCell.append(node("small", "", "已核對恢復"));
      if (window.TargetEngine.pending(trade)) stateCell.append(node("small", "", trade.recovery?.pending ? "目標核對中" : "目標繼續追蹤"));
      row.append(identity, cell("方向", trade.direction === "LONG" ? "做多" : "做空"), cell("模擬進場", price(trade.entry)),
        cell(trade.status==="OPEN"&&trade.exitGuard?"目前保護價":"停損", price(trade.status==="OPEN"&&trade.exitGuard?trade.exitGuard.price:trade.stopLoss)), targetCell, cell(trade.partialExit ? "剩餘／初始數量" : "數量", trade.partialExit && trade.quantity ? price(trade.remainingQuantity) + " / " + price(trade.quantity) : price(trade.quantity)),
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
        const candidate = window.ZecRecordedFill;
        if (candidate) {
          const trade = model.trades.find(t => t.id === Engine.key(candidate));
          if (trade?.openedAt) model.resumeRecordedFill(trade, now());
          else model.recordLimitFill(candidate, 100, now());
        }
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
      if(model.trades.some(t=>t.closedAt===quote.timestamp)){lastFundingAt=0;void syncFunding();}
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
    const currentAccount = model.accountSnapshot(); next.enableAccount(100, now(), currentAccount?.limits || window.AccountRisk.DEFAULTS);next.startStrategySession(100,now());
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
  document.addEventListener('visibilitychange',()=>{
    if(document.visibilityState==='hidden'&&isLeader){model.suspend('手機進入背景，返回後自動核對既有持倉',now());changed=dirty=true;save(true);}
    else if(document.visibilityState==='visible'&&isLeader){void pumpRecovery();lastFundingAt=0;void syncFunding();}
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
    ingest(); syncSymbols(); save(); render(); void pumpRecovery(); void syncFunding();
  }, 1000);
  render(); void acquire();
})();
