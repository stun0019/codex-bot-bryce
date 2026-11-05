(function (root) {
  "use strict";
  const Engine = root.StrategyEngine || (typeof require === "function" ? require("./strategy-engine.js") : null);
  const Targets = root.TargetEngine || (typeof require === "function" ? require("./target-engine.js") : null);
  const Smc = root.SmcEngine || (typeof require === "function" ? require("./smc-engine.js") : null);
  const Account = root.AccountRisk || (typeof require === "function" ? require("./account-risk.js") : null);
  const Ema = root.EmaEngine || (typeof require === "function" ? require("./ema-engine.js") : null);
  const Fib = root.FibEngine || (typeof require === "function" ? require("./fib-engine.js") : null);
  const fib = trade => Fib?.isVersion(trade.strategyVersion) === true;
  const ema = trade => Ema?.isVersion(trade.strategyVersion) === true;
  const smc = trade => Smc.isVersion(trade.strategyVersion) || ema(trade) || fib(trade);
  const DEFAULTS = Object.freeze({ enabled: true, feeRate: 0.0005, slippage: 0.0002 });
  const ACTIVE = new Set(["WAITING_PRICE", "OPEN"]), CLOSED = new Set(["TAKE_PROFIT", "STOP_LOSS"]);
  const STATUSES = new Set([...ACTIVE, ...CLOSED, "SKIPPED", "REVIEW"]);
  const MAX_GAP_MS = 30000;
  function settings(value = {}) {
    const valid = number => typeof number === "number" && Number.isFinite(number) && number >= 0 && number <= 0.01;
    return { enabled: typeof value.enabled === "boolean" ? value.enabled : DEFAULTS.enabled,
      feeRate: valid(value.feeRate) ? value.feeRate : DEFAULTS.feeRate,
      slippage: valid(value.slippage) ? value.slippage : DEFAULTS.slippage };
  }
  const finite = value => typeof value === "number" && Number.isFinite(value);
  const key = candidate => candidate.symbol + ":" + candidate.direction + ":" + candidate.confirmedAt + (candidate.strategyVersion ? ":" + candidate.strategyVersion + ":" + candidate.profileId + ":" + candidate.setupId : "");

  function createModel(saved = null) {
    if (saved && (saved.version !== 1 || !Array.isArray(saved.trades))) throw new Error("模擬紀錄格式無法讀取");
    const config = settings(saved?.settings), trades = saved ? JSON.parse(JSON.stringify(saved.trades)) : [];
    const ignoreBefore = saved?.ignoreBefore ?? 0;
    if (!finite(ignoreBefore) || ignoreBefore < 0) throw new Error("模擬紀錄清空時間無效");
    const seen = new Set();
    for (const trade of trades) {
      if (!trade || (trade.strategyVersion && !validSmc(trade)) || (trade.checkpoint !== undefined && !validCursor(trade.checkpoint)) || (trade.recovery?.pending && (!validCursor(trade.checkpoint) || !hasWork(trade))) || !Targets.valid(trade) || !STATUSES.has(trade.status) || !/^[A-Z0-9]+USDT$/.test(trade.symbol) ||
          !["LONG", "SHORT"].includes(trade.direction) || trade.id !== key(trade) || seen.has(trade.id) ||
          !finite(trade.detectedAt) || !finite(trade.confirmedAt) || !finite(trade.expiresAt) ||
          !(trade.stopLoss > 0) || !(trade.target > 0) || !(trade.tickSize > 0) || !(trade.capital > 0) ||
          !trade.market || !(trade.market.stepSize > 0) || !finite(trade.feeRate) || !finite(trade.slippage) ||
          trade.feeRate < 0 || trade.feeRate > 0.01 || trade.slippage < 0 || trade.slippage > 0.01 ||
          ((trade.status === "OPEN" || CLOSED.has(trade.status)) &&
            (!(trade.entry > 0) || !(trade.quantity > 0) || !finite(trade.entryFee) || !finite(trade.openedAt))) ||
          (CLOSED.has(trade.status) && (!finite(trade.netPnl) || !finite(trade.closedAt)))) throw new Error("模擬紀錄含無效或重複資料");
      seen.add(trade.id);
    }
    let account = saved?.account ? Account.validate(saved.account, trades) : null;
    for (const trade of trades) if (trade.accountId && (!account || trade.accountId !== account.id || !validReservedPlan(trade))) throw new Error("共用帳戶預留計畫無效");
    function enableAccount(capital = 200, at = Date.now(), limits = Account.DEFAULTS) {
      if (account) return false;
      for (const trade of trades) if (trade.status === "WAITING_PRICE") skip(trade, "升級共用帳戶，舊待成交計畫不回填；等待新掃描預留", at);
      account = Account.create(trades, capital, at, limits); return true;
    }
    function accountState(at = Date.now(), excludeId = null) { return account ? Account.metrics(trades, account, at, excludeId) : null; }
    const priority = (a, b) => (Number(b.market?.quoteVolume24h) || 0) - (Number(a.market?.quoteVolume24h) || 0) || (a.profileId === b.profileId ? 0 : a.profileId === "4h15m" ? -1 : 1) || a.symbol.localeCompare(b.symbol) || a.confirmedAt - b.confirmedAt;
    function validReservedPlan(trade) {
      const plan = trade.reservedPlan;
      if (!plan || !plan.ok || plan.accountId !== trade.accountId || !(plan.quantity > 0)) return false;
      const candidate = { ...trade, entry: trade.referenceEntry, targets: trade.plannedTargets };
      const expected = Engine.position(candidate, trade.market, trade.capital, { entry: trade.referenceEntry, budget: trade.budget, riskFraction: smc(trade) ? .05 : .03, feeRate: trade.feeRate, slippage: trade.slippage, partialExit: smc(trade), leverage: plan.leverage, quantity: plan.quantity });
      return expected.ok && ["entry", "quantity", "risk", "entryFee", "stopExitFee", "initialMargin", "feeReserve", "marginReserve", "budget"].every(k => finite(plan[k]) && Math.abs(plan[k] - expected[k]) <= 1e-8 * Math.max(1, Math.abs(expected[k])));
    }
    function previewCandidates(candidates, capital = 200, at = Date.now()) {
      const result = new Map(), extra = [];
      for (const candidate of [...candidates].sort(priority)) {
        const id = key(candidate), recorded = trades.find(t => t.id === id); let plan;
        if (recorded) {
          plan = recorded.status === "WAITING_PRICE" && recorded.reservedPlan ? { ...recorded.reservedPlan, status: "RESERVED", reason: "已預留；成交前重新核驗" } :
            recorded.status === "OPEN" ? { ...(recorded.executionPlan || recorded.reservedPlan), ok: true, status: "OPEN", quantity: recorded.quantity, reason: "已進場，原始數量已固定" } : { ok: false, status: recorded.status, reason: recorded.reason || "此計畫已結束" };
          const state = accountState(at); if (recorded.status === "WAITING_PRICE" && state?.blockedReason) plan = { ...plan, ok: false, status: "BLOCKED", reason: state.blockedReason };
        } else if (candidate.confirmedAt <= ignoreBefore || candidate.expiresAt <= at) plan = { ok: false, reason: "此訊號已清空或到期" };
        else if (!config.enabled) plan = { ok: false, reason: "已暫停新增" };
        else if (account) {
          plan = Account.plan(candidate, config, Account.metrics([...trades, ...extra], account, at));
          if (plan.ok) extra.push({ id, symbol: candidate.symbol, direction: candidate.direction, status: "WAITING_PRICE", reservedPlan: plan });
        } else plan = Engine.position(candidate, candidate.market, capital, config);
        result.set(id, plan);
      }
      return result;
    }
    function enforceAccount(at = Date.now()) {
      if (!account) return false; let changed = false;
      for (const trade of trades.filter(t => t.status === "WAITING_PRICE" && t.accountId === account.id).sort(priority).reverse()) {
        const state = accountState(at); if (!state.blockedReason) break;
        skip(trade, state.blockedReason, at); changed = true;
      }
      return changed;
    }
    function skip(trade, reason, at) { trade.status = "SKIPPED"; trade.reason = reason; trade.resolvedAt = at; }
    function review(trade, reason, at) {
      Targets.interrupt(trade, reason, at);
      if (trade.status === "WAITING_PRICE") skip(trade, reason, at);
      else if (trade.status === "OPEN") { trade.status = "REVIEW"; trade.reason = reason; trade.reviewAt = at; }
    }
    function fill(trade, price, entering) {
      const buying = (trade.direction === "LONG") === entering;
      return Engine.quantize(price * (buying ? 1 + trade.slippage : 1 - trade.slippage), trade.tickSize, buying ? "ceil" : "floor");
    }
    function addCandidates(candidates, capital, now) {
      if (!config.enabled || !(capital > 0) || !finite(capital)) return 0;
      let added = 0;
      if (account) enforceAccount(now);
      for (const candidate of (account ? [...candidates].sort(priority) : candidates)) {
        if (!candidate || (fib(candidate)&&!Fib.valid(candidate)) || (candidate.strategyVersion && (!smc(candidate) || !Smc.PROFILES[candidate.profileId] || !Array.isArray(candidate.targets) || candidate.targets.length !== 4 || typeof candidate.setupId !== "string")) || !/^[A-Z0-9]+USDT$/.test(candidate.symbol) || !["LONG", "SHORT"].includes(candidate.direction) ||
            !finite(candidate.confirmedAt) || candidate.confirmedAt <= ignoreBefore || !finite(candidate.expiresAt) || candidate.confirmedAt > now || candidate.expiresAt <= now ||
            !(candidate.stopLoss > 0) || !(candidate.target > 0) || !(candidate.tickSize > 0) ||
            !(candidate.market?.stepSize > 0) || seen.has(key(candidate))) continue;
        const reservedPlan = account ? Account.plan(candidate, config, accountState(now)) : null;
        if (account && !reservedPlan.ok) continue;
        const trade = { id: key(candidate), symbol: candidate.symbol, direction: candidate.direction,
          confirmedAt: candidate.confirmedAt, detectedAt: now, expiresAt: candidate.expiresAt,
          referenceEntry: candidate.entry, stopLoss: candidate.stopLoss, target: candidate.target,
          ...(candidate.strategyVersion ? { strategyVersion: candidate.strategyVersion, profileId: candidate.profileId, timeframeLabel: Smc.profile(candidate.profileId).label, setupId: candidate.setupId, entryType: fib(candidate)?"LIMIT_FIB":ema(candidate)?"LIMIT_CONFIRM":"LIMIT_OB", strategyName:candidate.strategyName||(fib(candidate)?"EMA＋Fib":ema(candidate)?"EMA":"SMC"), ...(fib(candidate)?{targetMode:"FIB",fib:JSON.parse(JSON.stringify(candidate.fib)),exitFractions:[.2,.3,.3,.2]}:{}), emaTrend: candidate.emaTrend || null, pullback: candidate.pullback || null, partialExit: true, targetCount: 4, riskFraction: .05, highZone: candidate.highZone, entryZone: candidate.entryZone, shiftLevel: candidate.shiftLevel, macd: candidate.macd || null, entryFilter: candidate.entryFilter || {enabled:false}, plannedTargets: [...candidate.targets] } : {}),
          ...(reservedPlan ? { accountId: account.id, reservedPlan: { ...reservedPlan } } : {}),
          tickSize: candidate.tickSize, capital: reservedPlan ? reservedPlan.capital : capital, budget: reservedPlan ? reservedPlan.budget : capital * (candidate.strategyVersion ? .05 : 0.03),
          market: { ...candidate.market }, feeRate: config.feeRate, slippage: config.slippage,
          status: "WAITING_PRICE", reason: candidate.strategyVersion==="macd-body-bos-4h15m-v2"?"MACD同向與回抽已確認，等待確認價新成交觸價":fib(candidate)?"區域與收盤破結構已確認，等待Fib 0.715新成交觸價":ema(candidate) ? "EMA確認，等待新成交報價到確認收盤參考價限價成交" : candidate.strategyVersion ? "等待新成交報價回測 OB 中線；不回填歷史成交" : "等待訊號產生後的新成交報價" };
        trades.push(trade); seen.add(trade.id); added++;
      }
      return added;
    }
    function open(trade, price, at) {
      const entry = smc(trade) ? trade.referenceEntry : fill(trade, price, true), long = trade.direction === "LONG";
      if (!(entry > 0) || (long ? entry <= trade.stopLoss || entry >= trade.target : entry >= trade.stopLoss || entry <= trade.target)) {
        skip(trade, "進場報價已越過停損或目標", at); return;
      }
      const distance = Math.abs(entry - trade.stopLoss), rr = Math.abs(trade.target - entry) / distance;
      if (rr < 2) { skip(trade, "實際模擬進場的價差盈虧比不足 1:2", at); return; }
      const candidate = { ...trade, entry, targets: trade.plannedTargets };
      const plan = Engine.position(candidate, trade.market, trade.capital, { entry, budget: trade.budget, riskFraction: smc(trade) ? .05 : .03, feeRate: trade.feeRate, slippage: trade.slippage,
        partialExit: smc(trade), leverage: trade.reservedPlan?.leverage || 50, ...(trade.reservedPlan ? { quantity: trade.reservedPlan.quantity } : {}) });
      if (!plan.ok) { skip(trade, plan.reason, at); return; }
      if (account) {
        const reason = Account.canOpen(plan, accountState(at, trade.id), trade.direction, price);
        if (reason) { skip(trade, reason, at); return; }
      }
      const quantity = plan.quantity; trade.executionPlan = { ...plan };
      if (smc(trade)) {
        trade.remainingQuantity = quantity; trade.realizedGross = 0; trade.realizedExitFees = 0; trade.exitFills = [];
        trade.exitLegs = plan.exitQuantities.map((quantity, i) => ({ label: "TP" + (i + 1), price: trade.plannedTargets[i], quantity, status: "PENDING" }));
      }
      trade.targets = fib(trade)?Targets.createFib(trade):Targets.create(entry, trade.stopLoss, trade.direction, trade.tickSize, smc(trade) ? 4 : 3); trade.targetsLastQuoteAt = at;
      Object.assign(trade, { status: "OPEN", reason: "連續追蹤中", entry, quantity, openedAt: at,
        observedEntry: price, entryFee: entry * quantity * trade.feeRate,
        estimatedStopRisk: plan.risk, entryRewardRisk: rr, lastPrice: price, lastQuoteAt: at });
    }
    function netAt(trade, price) {
      if (smc(trade) && finite(trade.remainingQuantity)) {
        const exit = fill(trade, price, false), remaining = trade.remainingQuantity;
        const gross = trade.realizedGross + (exit - trade.entry) * remaining * (trade.direction === "LONG" ? 1 : -1);
        const exitFee = trade.realizedExitFees + exit * remaining * trade.feeRate;
        const average = remaining === 0 && trade.exitFills.length ? trade.exitFills.reduce((sum, f) => sum + f.price * f.quantity, 0) / trade.quantity : exit;
        return { exit: average, gross, exitFee, net: gross - trade.entryFee - exitFee };
      }
      const exit = fill(trade, price, false), gross = (exit - trade.entry) * trade.quantity * (trade.direction === "LONG" ? 1 : -1);
      return { exit, gross, exitFee: exit * trade.quantity * trade.feeRate,
        net: gross - trade.entryFee - exit * trade.quantity * trade.feeRate };
    }
    function validSmc(trade) {
      if(fib(trade))return validFibTrade(trade);
      if (!smc(trade) || !Smc.PROFILES[trade.profileId] || typeof trade.setupId !== "string" || trade.entryType !== (ema(trade)?"LIMIT_CONFIRM":"LIMIT_OB") || trade.targetCount !== 4 || trade.partialExit !== true || trade.riskFraction !== .05 || !Array.isArray(trade.plannedTargets) || trade.plannedTargets.length !== 4 || trade.plannedTargets.some(p => !(p > 0))) return false;
      const expected = Engine.targets(trade.referenceEntry, trade.stopLoss, trade.direction, trade.tickSize);
      if (trade.plannedTargets.some((p, i) => p !== expected[i])) return false;
      if (trade.status === "OPEN" || CLOSED.has(trade.status)) {
        if (!finite(trade.remainingQuantity) || trade.remainingQuantity < 0 || trade.remainingQuantity > trade.quantity || !finite(trade.realizedGross) || !finite(trade.realizedExitFees) || trade.realizedExitFees < 0 || !Array.isArray(trade.exitFills) || !Array.isArray(trade.exitLegs) || trade.exitLegs.length !== 3) return false;
        if (trade.exitFills.some(f => !finite(f.quantity) || f.quantity <= 0 || !(f.price > 0) || !finite(f.at) || !finite(f.fee))) return false;
        const total = trade.exitFills.reduce((sum, f) => sum + f.quantity, 0);
        if (Math.abs(total + trade.remainingQuantity - trade.quantity) > 1e-8 * Math.max(1, trade.quantity)) return false;
        if (trade.exitLegs.some(l => !["PENDING", "FILLED", "CANCELLED"].includes(l.status) || !(l.quantity > 0) || !(l.price > 0))) return false;
        const first = Engine.quantize(trade.quantity * .3, trade.market.stepSize, "floor"), quantities = [first, first, Number((trade.quantity - first * 2).toFixed(Math.min(14, Engine.decimals(trade.market.stepSize))))];
        if (trade.exitLegs.some((l, i) => l.label !== "TP" + (i + 1) || l.price !== expected[i] || l.quantity !== quantities[i])) return false;
        const gross = trade.exitFills.reduce((sum, f) => sum + (f.price - trade.entry) * f.quantity * (trade.direction === "LONG" ? 1 : -1), 0), fees = trade.exitFills.reduce((sum, f) => sum + f.fee, 0);
        const near = (a, b) => Math.abs(a - b) <= 1e-8 * Math.max(1, Math.abs(a), Math.abs(b));
        if (!near(gross, trade.realizedGross) || !near(fees, trade.realizedExitFees) || trade.exitFills.some(f => !near(f.fee, f.price * f.quantity * trade.feeRate))) return false;
        if (CLOSED.has(trade.status) && !near(trade.netPnl, gross - trade.entryFee - fees)) return false;
        if (CLOSED.has(trade.status) && trade.remainingQuantity !== 0) return false;
      }
      return true;
    }
    function validFibTrade(t){
      if(!Fib.valid(t)||t.partialExit!==true||t.targetCount!==4||t.riskFraction!==.05)return false;
      if(!(t.entry>0))return t.exitGuard===undefined;
      if(!finite(t.quantity)||t.quantity<=0||!finite(t.remainingQuantity)||t.remainingQuantity<0||t.remainingQuantity>t.quantity||!finite(t.entryFee)||!finite(t.realizedGross)||!finite(t.realizedExitFees)||!Array.isArray(t.exitFills)||!Array.isArray(t.exitLegs)||t.exitLegs.length!==4)return false;
      const quantities=Engine.partialQuantities(t.quantity,t.market.stepSize,[.2,.3,.3,.2]),near=(a,b)=>finite(a)&&finite(b)&&Math.abs(a-b)<=1e-8*Math.max(1,Math.abs(a),Math.abs(b));
      let notFilled=false;
      for(let i=0;i<4;i++){const l=t.exitLegs[i];if(l.label!=="TP"+(i+1)||l.price!==t.plannedTargets[i]||l.quantity!==quantities[i]||!["PENDING","FILLED","CANCELLED"].includes(l.status))return false;if(l.status!=="FILLED")notFilled=true;else if(notFilled||!finite(l.at))return false;}
      if(t.exitFills.some(f=>!finite(f.quantity)||f.quantity<=0||!finite(f.price)||f.price<=0||!finite(f.at)||!finite(f.fee)||!near(f.fee,f.price*f.quantity*t.feeRate)||!/^TP[1-4]$|^STOP$|^RETRACE_TP[1-3]$/.test(f.label)))return false;
      for(const l of t.exitLegs){const fills=t.exitFills.filter(f=>f.label===l.label);if(l.status==="FILLED"?(fills.length!==1||fills[0].quantity!==l.quantity||fills[0].at!==l.at):fills.length)return false;}
      const top=t.exitLegs.filter(l=>l.status==="FILLED").at(-1);
      if(top?(!t.exitGuard||t.exitGuard.price!==top.price||t.exitGuard.label!==top.label||t.exitGuard.activatedAt!==top.at||!finite(t.exitGuard.bestPrice)||(t.direction==="LONG"?t.exitGuard.bestPrice<t.exitGuard.price:t.exitGuard.bestPrice>t.exitGuard.price)):t.exitGuard!==undefined)return false;
      const gross=t.exitFills.reduce((s,f)=>s+(f.price-t.entry)*f.quantity*(t.direction==="LONG"?1:-1),0),fees=t.exitFills.reduce((s,f)=>s+f.fee,0),out=t.exitFills.reduce((s,f)=>s+f.quantity,0);
      if(!near(out+t.remainingQuantity,t.quantity)||!near(gross,t.realizedGross)||!near(fees,t.realizedExitFees))return false;
      if(CLOSED.has(t.status)&&(!near(t.netPnl,gross-t.entryFee-fees)||t.remainingQuantity!==0||t.exitLegs.some(l=>l.status==="PENDING")))return false;
      if(t.status==="OPEN"&&t.exitLegs.some(l=>l.status==="CANCELLED"))return false;
      return true;
    }
    function executeFib(trade,price,at,source){
      if(trade.status!=="OPEN")return false;
      const long=trade.direction==="LONG",guard=trade.exitGuard,stop=Targets.hitStop(trade,price);
      const reduce=(quantity,label)=>{const exit=fill(trade,price,false),fee=exit*quantity*trade.feeRate;trade.realizedGross+=(exit-trade.entry)*quantity*(long?1:-1);trade.realizedExitFees+=fee;
        trade.remainingQuantity=Number(Math.max(0,trade.remainingQuantity-quantity).toFixed(Math.min(14,Engine.decimals(trade.market.stepSize))));trade.exitFills.push({label,quantity,price:exit,fee,at,source});};
      // Check the previously armed protection before processing this new quote's target hits.
      if(stop){const label=guard?"RETRACE_"+guard.label:"STOP";reduce(trade.remainingQuantity,label);trade.exitReason=label;for(const leg of trade.exitLegs)if(leg.status==="PENDING")leg.status="CANCELLED";}
      else for(const leg of trade.exitLegs)if(leg.status==="PENDING"&&(long?price>=leg.price:price<=leg.price)){reduce(leg.quantity,leg.label);leg.status="FILLED";leg.at=at;trade.exitGuard={price:leg.price,label:leg.label,activatedAt:at,bestPrice:price};}
      if(!stop&&trade.exitGuard)trade.exitGuard.bestPrice=long?Math.max(trade.exitGuard.bestPrice,price):Math.min(trade.exitGuard.bestPrice,price);
      trade.lastPrice=price;trade.lastQuoteAt=at;
      if(trade.remainingQuantity===0){const result=netAt(trade,price);Object.assign(trade,{status:stop?"STOP_LOSS":"TAKE_PROFIT",closedAt:at,exit:result.exit,observedExit:price,grossPnl:result.gross,exitFee:result.exitFee,netPnl:result.net,exitSource:source,
        reason:stop?(guard?"回撤至"+guard.label+"，剩餘部位全部出場":"觸及原停損，剩餘部位全部出場"):"TP1 20%／TP2 30%／TP3 30%／TP4剩餘20%已完成"});}
      else trade.reason="Fib分批持倉中 · 剩餘 "+trade.remainingQuantity+(trade.exitGuard?" · 保護價 "+trade.exitGuard.label+" "+trade.exitGuard.price:"");
      return true;
    }
    function executeSmc(trade, price, at, source = "live") {
      if(fib(trade))return executeFib(trade,price,at,source);
      if (trade.status !== "OPEN") return false;
      const long = trade.direction === "LONG", stop = long ? price <= trade.stopLoss : price >= trade.stopLoss;
      const reduce = (quantity, label) => {
        const exit = fill(trade, price, false), fee = exit * quantity * trade.feeRate;
        trade.realizedGross += (exit - trade.entry) * quantity * (long ? 1 : -1); trade.realizedExitFees += fee;
        trade.remainingQuantity = Number(Math.max(0, trade.remainingQuantity - quantity).toFixed(Math.min(14, Engine.decimals(trade.market.stepSize))));
        trade.exitFills.push({ label, quantity, price: exit, fee, at, source });
      };
      if (stop) { reduce(trade.remainingQuantity, "STOP"); for (const leg of trade.exitLegs) if (leg.status === "PENDING") leg.status = "CANCELLED"; }
      else for (const leg of trade.exitLegs) if (leg.status === "PENDING" && (long ? price >= leg.price : price <= leg.price)) { reduce(leg.quantity, leg.label); leg.status = "FILLED"; leg.at = at; }
      trade.lastPrice = price; trade.lastQuoteAt = at;
      if (trade.remainingQuantity === 0) {
        const result = netAt(trade, price);
        Object.assign(trade, { status: stop ? "STOP_LOSS" : "TAKE_PROFIT", closedAt: at, exit: result.exit, observedExit: price, grossPnl: result.gross, exitFee: result.exitFee, netPnl: result.net, exitSource: source,
          reason: stop ? "剩餘部位觸及原停損；已實現分批損益保留" : "TP1 30%／TP2 30%／TP3 剩餘全部已出場" });
      } else trade.reason = "分批持倉中；剩餘 " + trade.remainingQuantity;
      return true;
    }
    function tryLimitFill(trade, price, at) {
      if (!smc(trade) || trade.status !== "WAITING_PRICE" || !(price > 0) || !finite(price) || !finite(at) || at < trade.detectedAt) return false;
      const long = trade.direction === "LONG";
      if (at >= trade.expiresAt) skip(trade, "限價候選到期", at);
      else if (long ? price <= trade.stopLoss || price >= trade.target : price >= trade.stopLoss || price <= trade.target) skip(trade, "進場前已越過停損或 TP1", at);
      else if (long ? price <= trade.referenceEntry : price >= trade.referenceEntry) open(trade, price, at);
      return trade.status !== "WAITING_PRICE";
    }
    function cancelOrder(trade, reason, at) { if (trade.status === "WAITING_PRICE") { skip(trade, reason, at); return true; } return false; }
    function reconcileCandidates(candidates, observations, at) {
      const ids = new Set(candidates.map(key)), checked = new Set(observations.filter(o => o.status !== "ERROR").map(o => o.symbol + ":" + o.profileId)); let changed = false;
      for (const trade of trades) if (smc(trade) && trade.status === "WAITING_PRICE" && (fib(trade)||checked.has(trade.symbol + ":" + trade.profileId)) && !ids.has(trade.id)) { skip(trade, "已收盤 K 線確認候選失效／已回測，不回填成交", at); changed = true; }
      return changed;
    }
    function hasWork(trade) { return trade.status === "OPEN" || Targets.pending(trade); }
    function validCursor(cursor) { return cursor && Number.isSafeInteger(cursor.id) && cursor.id >= 0 && finite(cursor.at) && cursor.at > 0 && finite(cursor.price) && cursor.price > 0; }
    function queueRecovery(trade, reason, at) {
      if (trade.status === "WAITING_PRICE") { skip(trade, "追蹤已中斷，不回填過期進場", at); return true; }
      if (!hasWork(trade) || trade.recovery?.pending) return false;
      if (!validCursor(trade.checkpoint)) { review(trade, "舊版缺少成交編號，無法自動核對：" + reason, at); return true; }
      trade.recovery = { ...trade.recovery, pending: true, state: "PENDING", reason, requestedAt: at, nextRetryAt: 0, attempts: 0, lastError: "" }; return true;
    }
    function suspend(reason, at, symbol = null) {
      let changed = false;
      for (const trade of trades) if ((!symbol || trade.symbol === symbol) && queueRecovery(trade, reason, at)) changed = true;
      return changed;
    }
    function recoveryTasks(at = Infinity) {
      return trades.filter(t => t.recovery?.pending && hasWork(t) && validCursor(t.checkpoint) && (t.recovery.nextRetryAt || 0) <= at);
    }
    function recoveryError(symbol, error, at) {
      for (const trade of recoveryTasks()) if (trade.symbol === symbol) {
        const rec = trade.recovery;
        Object.assign(rec, { attempts: (rec.attempts || 0) + 1, lastError: error.message, errorCode: error.code || "NETWORK", lastAttemptAt: at });
        if (error.permanent) {
          rec.resumePrimary = trade.status === "OPEN"; rec.resumeTargets = (trade.targets || []).map((t,i) => t.status === "PENDING" ? i : -1).filter(i => i >= 0);
          review(trade, "自動核對未完成：" + error.message, at); rec.pending = false; rec.state = "REVIEW";
        } else { rec.state = "RETRY"; rec.nextRetryAt = Math.max(error.retryAt || 0, at + Math.min(300000, 5000 * 2 ** Math.min(rec.attempts, 6))); }
      }
    }
    function retryRecovery(at) {
      let changed = false;
      for (const trade of trades) if (validCursor(trade.checkpoint) && trade.recovery) {
        const rec = trade.recovery;
        if (rec.state === "REVIEW") {
          if (rec.resumePrimary && trade.status === "REVIEW") { trade.status = "OPEN"; delete trade.reviewAt; }
          for (const index of rec.resumeTargets || []) { const target = trade.targets?.[index]; if (target?.status === "REVIEW") { target.status = "PENDING"; delete target.at; delete target.reason; } }
        }
        if (hasWork(trade) && (rec.pending || rec.state === "REVIEW")) { Object.assign(rec,{pending:true,state:"PENDING",nextRetryAt:0,requestedAt:at}); changed = true; }
      }
      return changed;
    }
    function observe(trade, price, at, source) {
      if (Targets.pending(trade)) { const pending = trade.targets.filter(t => t.status === "PENDING"); Targets.quote(trade, price, at); for (const target of pending) if (target.status !== "PENDING") target.source = source; trade.targetsLastQuoteAt = at; }
      if (trade.status !== "OPEN") return;
      if (smc(trade)) { executeSmc(trade, price, at, source); return; }
      trade.lastPrice = price; trade.lastQuoteAt = at;
      const long = trade.direction === "LONG", stopped = long ? price <= trade.stopLoss : price >= trade.stopLoss;
      const targeted = long ? price >= trade.target : price <= trade.target;
      if (!stopped && !targeted) return;
      const result = netAt(trade, price);
      Object.assign(trade, { status: stopped ? "STOP_LOSS" : "TAKE_PROFIT", closedAt: at, exit: result.exit,
        observedExit: price, grossPnl: result.gross, exitFee: result.exitFee, netPnl: result.net, exitSource: source,
        reason: source === "reconciled" ? "歷史聚合成交核對確認出場" : stopped ? "即時成交報價觸及停損" : "即時成交報價觸及目標" });
    }
    function applyRecovery(proof, at) {
      const { symbol, anchor, head, rows, complete } = proof || {};
      if (proof?.headCheckedAt !== undefined && (!finite(proof.headCheckedAt) || proof.headCheckedAt > at + 30000 || proof.headCheckedAt < head?.at - 30000)) throw new Error("核對銜接時間無效");
      if (!/^[A-Z0-9]+USDT$/.test(symbol) || !validCursor(anchor) || !validCursor(head) || !Array.isArray(rows) || !rows.length || head.id < anchor.id || head.at < anchor.at) throw new Error("核對資料格式無效");
      const same = (a,b) => a.id === b.id && a.at === b.at && a.price === b.price;
      if (!same(rows[0],anchor) || rows.some((row,i) => !validCursor(row) || row.id > head.id || (i && (row.id !== rows[i-1].id+1 || row.at < rows[i-1].at))) ||
          (complete ? !same(rows.at(-1),head) : rows.at(-1).id >= head.id)) throw new Error("核對成交編號不連續或銜接點不符");
      const replacements = [];
      for (const trade of recoveryTasks()) if (trade.symbol === symbol) {
        const cursor = trade.checkpoint, index = cursor.id - anchor.id;
        if (index >= rows.length) continue;
        if (index < 0 || !same(rows[index],cursor)) throw new Error("持倉檢查點與核對行情不符");
        const next = JSON.parse(JSON.stringify(trade));
        for (let i=index+1;i<rows.length;i++) {
          const row=rows[i]; observe(next,row.price,row.at,"reconciled"); next.checkpoint={...row};
          if (!hasWork(next)) break;
        }
        const finished = complete || !hasWork(next);
        next.recovery = { ...next.recovery, pending: !finished, state: finished ? "DONE" : "PENDING", nextRetryAt: finished ? 0 : at+1000,
          lastCheckedAt: finished ? (Number.isFinite(proof.headCheckedAt) ? proof.headCheckedAt : head.at) : next.recovery.lastCheckedAt, lastVerifiedAt: next.checkpoint.at, finishedAt: finished ? at : null, recovered: true, lastError: "" };
        if (next.status === "OPEN") next.reason = finished ? "核對完成，已恢復即時追蹤" : "已核對部分行情，繼續補查";
        replacements.push([trade,next]);
      }
      for (const [trade,next] of replacements) Object.assign(trade,next);
      if (account) enforceAccount(at);
      return replacements.length > 0;
    }

    function tick(symbol, price, at, metadata = {}) {
      if (!(price > 0) || !finite(price) || !finite(at)) return false;
      let changed = false;
      for (const trade of trades) {
        if (trade.symbol !== symbol || (!ACTIVE.has(trade.status) && !Targets.pending(trade)) || at < trade.detectedAt || at < (trade.lastQuoteAt || 0)) continue;
        if (trade.recovery?.pending) continue;
        const hasId = Number.isSafeInteger(metadata.aggregateId) && metadata.aggregateId >= 0;
        if (trade.checkpoint) {
          if (!hasId || metadata.aggregateId <= trade.checkpoint.id) continue;
          if (metadata.aggregateId !== trade.checkpoint.id + 1 || at - Math.max(trade.checkpoint.at, trade.recovery?.lastCheckedAt || 0) > MAX_GAP_MS) { queueRecovery(trade, "成交序列中斷，等待自動核對", at); changed = true; continue; }
        }
        if (trade.status === "WAITING_PRICE" && smc(trade)) {
          const long = trade.direction === "LONG";
          if (at >= trade.expiresAt || at - (trade.lastQuoteAt || trade.detectedAt) > MAX_GAP_MS) skip(trade, "限價候選到期或行情中斷；不回填進場", at);
          else if (long ? price <= trade.stopLoss || price >= trade.target : price >= trade.stopLoss || price <= trade.target) skip(trade, "進場前已越過停損或 TP1", at);
          else if (long ? price <= trade.referenceEntry : price >= trade.referenceEntry) open(trade, price, at);
          trade.lastQuoteAt = at;
          if (hasId && (trade.status === "WAITING_PRICE" || trade.status === "OPEN")) trade.checkpoint = { id: metadata.aggregateId, at, price };
          changed = true; continue;
        }
        if (trade.status === "WAITING_PRICE") {
          if (at >= Math.min(trade.expiresAt, trade.detectedAt + MAX_GAP_MS)) skip(trade, "未及時取得新成交報價", at);
          else { open(trade, price, at); if (trade.status === "OPEN" && hasId) trade.checkpoint = { id: metadata.aggregateId, at, price }; }
          changed = true; continue; // The fill tick cannot also close its newly opened trade.
        }
        if (hasId && trade.checkpoint) { observe(trade, price, at, "live"); trade.checkpoint = { id: metadata.aggregateId, at, price }; changed = true; continue; }
        if (Targets.pending(trade)) {
          if (at < trade.targetsLastQuoteAt) continue;
          if (at - trade.targetsLastQuoteAt > MAX_GAP_MS) Targets.interrupt(trade, "三段目標報價中斷，需核對", at);
          else { Targets.quote(trade, price, at); trade.targetsLastQuoteAt = at; }
          changed = true;
        }
        if (trade.status !== "OPEN") continue;
        if (at - trade.lastQuoteAt > MAX_GAP_MS) { review(trade, "報價追蹤中斷，期間觸價順序需核對", at); changed = true; continue; }
        trade.lastPrice = price; trade.lastQuoteAt = at; changed = true;
        if (smc(trade)) { executeSmc(trade, price, at, "live"); continue; }
        const long = trade.direction === "LONG";
        const stopped = long ? price <= trade.stopLoss : price >= trade.stopLoss;
        const targeted = long ? price >= trade.target : price <= trade.target;
        if (!stopped && !targeted) continue;
        const result = netAt(trade, price);
        Object.assign(trade, { status: stopped ? "STOP_LOSS" : "TAKE_PROFIT", closedAt: at,
          exit: result.exit, observedExit: price, grossPnl: result.gross, exitFee: result.exitFee,
          netPnl: result.net, reason: stopped ? "即時成交報價觸及停損" : "即時成交報價觸及目標" });
      }
      if (account && enforceAccount(at)) changed = true;
      return changed;
    }
    function interrupt(reason, at) {
      let changed = false;
      for (const trade of trades) { if (Targets.interrupt(trade, reason, at)) changed = true; if (ACTIVE.has(trade.status)) { review(trade, reason, at); changed = true; } }
      return changed;
    }
    function expire(now) {
      let changed = account ? enforceAccount(now) : false;
      for (const trade of trades) {
        if (trade.recovery?.pending) continue;
        if (trade.status === "WAITING_PRICE" && smc(trade)) {
          if (now >= trade.expiresAt || now - (trade.lastQuoteAt || trade.detectedAt) > MAX_GAP_MS) { skip(trade, "限價候選到期或行情中斷；不回填進場", now); changed = true; }
          continue;
        }
        if (trade.status === "WAITING_PRICE" && now >= Math.min(trade.expiresAt, trade.detectedAt + MAX_GAP_MS)) { skip(trade, "未及時取得新成交報價", now); changed = true; }
        else if (trade.checkpoint && hasWork(trade) && now - Math.max(trade.checkpoint.at, trade.recovery?.lastCheckedAt || 0) > MAX_GAP_MS) { if (queueRecovery(trade, "超過 30 秒未取得成交，等待自動核對", now)) changed = true; }
        else if (!trade.checkpoint) {
          if (Targets.pending(trade) && now - trade.targetsLastQuoteAt > MAX_GAP_MS) { Targets.interrupt(trade, "三段目標超過 30 秒無報價，需核對", now); changed = true; }
          if (trade.status === "OPEN" && now - trade.lastQuoteAt > MAX_GAP_MS) { review(trade, "超過 30 秒未取得成交報價，需核對", now); changed = true; }
        }
      }
      return changed;
    }
    function stats(profileId = "all") {
      const cohort = trades.filter(t => profileId === "macd" ? t.strategyVersion === "macd-body-bos-4h15m-v2" : profileId === "all" || (profileId === "pre-fib" ? !fib(t) : profileId === "fib" ? fib(t) : profileId.startsWith("fib:") ? fib(t)&&t.profileId===profileId.slice(4) : profileId === "ema" ? ema(t) : profileId === "previous" ? !ema(t)&&!fib(t) : profileId.startsWith("ema:") ? ema(t) && t.profileId === profileId.slice(4) : profileId === "smc" ? smc(t) : profileId === "legacy" ? !smc(t) : smc(t) && t.profileId === profileId));
      const closed = cohort.filter(trade => CLOSED.has(trade.status)).sort((a,b) => a.closedAt - b.closedAt || a.id.localeCompare(b.id));
      const wins = closed.filter(trade => trade.netPnl > 0).length;
      let pnl = 0, peak = 0, maxDrawdown = 0, streak = 0, maxLossStreak = 0;
      for (const trade of closed) {
        pnl += trade.netPnl; peak = Math.max(peak, pnl); maxDrawdown = Math.max(maxDrawdown, peak - pnl);
        streak = trade.netPnl < 0 ? streak + 1 : 0; maxLossStreak = Math.max(maxLossStreak, streak);
      }
      const byDirection = direction => { const rows = closed.filter(t => t.direction === direction); return { count: rows.length,
        winRate: rows.length ? rows.filter(t => t.netPnl > 0).length / rows.length * 100 : null }; };
      return { recovering: cohort.filter(t => t.recovery?.pending).length, reconciledClosed: closed.filter(t => t.exitSource === "reconciled").length, continuousClosed: closed.filter(t => t.exitSource !== "reconciled").length, legacyReview: cohort.filter(t => !t.checkpoint && (t.status === "REVIEW" || t.targets?.some(level => level.status === "REVIEW"))).length, targets: Targets.stats(cohort,{targetMode:profileId==="fib"||profileId.startsWith("fib:")?"FIB":undefined}), closed: closed.length, wins, losses: closed.filter(t => t.netPnl < 0).length,
        winRate: closed.length ? wins / closed.length * 100 : null, netPnl: pnl,
        averagePnl: closed.length ? pnl / closed.length : null, maxDrawdown, maxLossStreak,
        open: cohort.filter(t => t.status === "OPEN" && !t.recovery?.pending).length, waiting: cohort.filter(t => t.status === "WAITING_PRICE").length,
        skipped: cohort.filter(t => t.status === "SKIPPED").length, review: cohort.filter(t => t.status === "REVIEW").length,
        long: byDirection("LONG"), short: byDirection("SHORT") };
    }
    return { trades, settings: config, enableAccount, accountState, previewCandidates, enforceAccount, accountSnapshot: () => account ? JSON.parse(JSON.stringify(account)) : null, addCandidates, tick, interrupt, expire, stats, netAt, executeSmc, tryLimitFill, cancelOrder, reconcileCandidates, suspend, recoveryTasks, recoveryError, retryRecovery, applyRecovery,
      activeSymbols: () => [...new Set(trades.filter(t => ACTIVE.has(t.status) || Targets.pending(t)).map(t => t.symbol))],
      snapshot: () => ({ version: 1, settings: { ...config }, trades, ...(ignoreBefore > 0 ? { ignoreBefore } : {}), ...(account ? { account: JSON.parse(JSON.stringify(account)) } : {}) }) };
  }
  const api = { createModel, DEFAULTS, MAX_GAP_MS, CLOSED, key };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.PaperEngine = api;
})(typeof window !== "undefined" ? window : globalThis);
