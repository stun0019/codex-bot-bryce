(function (root) {
  "use strict";
  const Engine = root.StrategyEngine || (typeof require === "function" ? require("./strategy-engine.js") : null);
  const Targets = root.TargetEngine || (typeof require === "function" ? require("./target-engine.js") : null);
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
  const key = candidate => candidate.symbol + ":" + candidate.direction + ":" + candidate.confirmedAt;

  function createModel(saved = null) {
    if (saved && (saved.version !== 1 || !Array.isArray(saved.trades))) throw new Error("模擬紀錄格式無法讀取");
    const config = settings(saved?.settings), trades = saved ? JSON.parse(JSON.stringify(saved.trades)) : [];
    const ignoreBefore = saved?.ignoreBefore ?? 0;
    if (!finite(ignoreBefore) || ignoreBefore < 0) throw new Error("模擬紀錄清空時間無效");
    const seen = new Set();
    for (const trade of trades) {
      if (!trade || (trade.checkpoint !== undefined && !validCursor(trade.checkpoint)) || (trade.recovery?.pending && (!validCursor(trade.checkpoint) || !hasWork(trade))) || !Targets.valid(trade) || !STATUSES.has(trade.status) || !/^[A-Z0-9]+USDT$/.test(trade.symbol) ||
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
      for (const candidate of candidates) {
        if (!candidate || !/^[A-Z0-9]+USDT$/.test(candidate.symbol) || !["LONG", "SHORT"].includes(candidate.direction) ||
            !finite(candidate.confirmedAt) || candidate.confirmedAt <= ignoreBefore || !finite(candidate.expiresAt) || candidate.confirmedAt > now || candidate.expiresAt <= now ||
            !(candidate.stopLoss > 0) || !(candidate.target > 0) || !(candidate.tickSize > 0) ||
            !(candidate.market?.stepSize > 0) || seen.has(key(candidate))) continue;
        const trade = { id: key(candidate), symbol: candidate.symbol, direction: candidate.direction,
          confirmedAt: candidate.confirmedAt, detectedAt: now, expiresAt: candidate.expiresAt,
          referenceEntry: candidate.entry, stopLoss: candidate.stopLoss, target: candidate.target,
          tickSize: candidate.tickSize, capital, budget: capital * 0.03,
          market: { ...candidate.market }, feeRate: config.feeRate, slippage: config.slippage,
          status: "WAITING_PRICE", reason: "等待訊號產生後的新成交報價" };
        trades.push(trade); seen.add(trade.id); added++;
      }
      return added;
    }
    function open(trade, price, at) {
      const entry = fill(trade, price, true), long = trade.direction === "LONG";
      if (!(entry > 0) || (long ? entry <= trade.stopLoss || entry >= trade.target : entry >= trade.stopLoss || entry <= trade.target)) {
        skip(trade, "進場報價已越過停損或目標", at); return;
      }
      const distance = Math.abs(entry - trade.stopLoss), rr = Math.abs(trade.target - entry) / distance;
      if (rr < 2) { skip(trade, "實際模擬進場的價差盈虧比不足 1:2", at); return; }
      const stopFill = fill(trade, trade.stopLoss, false);
      const riskPerUnit = Math.abs(entry - stopFill) + (entry + stopFill) * trade.feeRate;
      const step = trade.market.stepSize;
      let quantity = Engine.quantize(Math.min(trade.budget / riskPerUnit, trade.market.maxQty || Infinity), step, "floor");
      if (quantity * riskPerUnit > trade.budget) quantity = Number((quantity - step).toFixed(Math.min(14, Engine.decimals(step))));
      if (!(quantity > 0) || quantity < (trade.market.minQty || 0) || quantity * entry < (trade.market.minNotional || 0)) {
        skip(trade, "含估算費用的風險預算不足幣安最小部位", at); return;
      }
      trade.targets = Targets.create(entry, trade.stopLoss, trade.direction, trade.tickSize); trade.targetsLastQuoteAt = at;
      Object.assign(trade, { status: "OPEN", reason: "連續追蹤中", entry, quantity, openedAt: at,
        observedEntry: price, entryFee: entry * quantity * trade.feeRate,
        estimatedStopRisk: quantity * riskPerUnit, entryRewardRisk: rr, lastPrice: price, lastQuoteAt: at });
    }
    function netAt(trade, price) {
      const exit = fill(trade, price, false), gross = (exit - trade.entry) * trade.quantity * (trade.direction === "LONG" ? 1 : -1);
      return { exit, gross, exitFee: exit * trade.quantity * trade.feeRate,
        net: gross - trade.entryFee - exit * trade.quantity * trade.feeRate };
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
        const long = trade.direction === "LONG";
        const stopped = long ? price <= trade.stopLoss : price >= trade.stopLoss;
        const targeted = long ? price >= trade.target : price <= trade.target;
        if (!stopped && !targeted) continue;
        const result = netAt(trade, price);
        Object.assign(trade, { status: stopped ? "STOP_LOSS" : "TAKE_PROFIT", closedAt: at,
          exit: result.exit, observedExit: price, grossPnl: result.gross, exitFee: result.exitFee,
          netPnl: result.net, reason: stopped ? "即時成交報價觸及停損" : "即時成交報價觸及目標" });
      }
      return changed;
    }
    function interrupt(reason, at) {
      let changed = false;
      for (const trade of trades) { if (Targets.interrupt(trade, reason, at)) changed = true; if (ACTIVE.has(trade.status)) { review(trade, reason, at); changed = true; } }
      return changed;
    }
    function expire(now) {
      let changed = false;
      for (const trade of trades) {
        if (trade.recovery?.pending) continue;
        if (trade.status === "WAITING_PRICE" && now >= Math.min(trade.expiresAt, trade.detectedAt + MAX_GAP_MS)) { skip(trade, "未及時取得新成交報價", now); changed = true; }
        else if (trade.checkpoint && hasWork(trade) && now - Math.max(trade.checkpoint.at, trade.recovery?.lastCheckedAt || 0) > MAX_GAP_MS) { if (queueRecovery(trade, "超過 30 秒未取得成交，等待自動核對", now)) changed = true; }
        else if (!trade.checkpoint) {
          if (Targets.pending(trade) && now - trade.targetsLastQuoteAt > MAX_GAP_MS) { Targets.interrupt(trade, "三段目標超過 30 秒無報價，需核對", now); changed = true; }
          if (trade.status === "OPEN" && now - trade.lastQuoteAt > MAX_GAP_MS) { review(trade, "超過 30 秒未取得成交報價，需核對", now); changed = true; }
        }
      }
      return changed;
    }
    function stats() {
      const closed = trades.filter(trade => CLOSED.has(trade.status)).sort((a,b) => a.closedAt - b.closedAt || a.id.localeCompare(b.id));
      const wins = closed.filter(trade => trade.netPnl > 0).length;
      let pnl = 0, peak = 0, maxDrawdown = 0, streak = 0, maxLossStreak = 0;
      for (const trade of closed) {
        pnl += trade.netPnl; peak = Math.max(peak, pnl); maxDrawdown = Math.max(maxDrawdown, peak - pnl);
        streak = trade.netPnl < 0 ? streak + 1 : 0; maxLossStreak = Math.max(maxLossStreak, streak);
      }
      const byDirection = direction => { const rows = closed.filter(t => t.direction === direction); return { count: rows.length,
        winRate: rows.length ? rows.filter(t => t.netPnl > 0).length / rows.length * 100 : null }; };
      return { recovering: trades.filter(t => t.recovery?.pending).length, reconciledClosed: closed.filter(t => t.exitSource === "reconciled").length, continuousClosed: closed.filter(t => t.exitSource !== "reconciled").length, legacyReview: trades.filter(t => !t.checkpoint && (t.status === "REVIEW" || t.targets?.some(level => level.status === "REVIEW"))).length, targets: Targets.stats(trades), closed: closed.length, wins, losses: closed.filter(t => t.netPnl < 0).length,
        winRate: closed.length ? wins / closed.length * 100 : null, netPnl: pnl,
        averagePnl: closed.length ? pnl / closed.length : null, maxDrawdown, maxLossStreak,
        open: trades.filter(t => t.status === "OPEN" && !t.recovery?.pending).length, waiting: trades.filter(t => t.status === "WAITING_PRICE").length,
        skipped: trades.filter(t => t.status === "SKIPPED").length, review: trades.filter(t => t.status === "REVIEW").length,
        long: byDirection("LONG"), short: byDirection("SHORT") };
    }
    return { trades, settings: config, addCandidates, tick, interrupt, expire, stats, netAt, suspend, recoveryTasks, recoveryError, retryRecovery, applyRecovery,
      activeSymbols: () => [...new Set(trades.filter(t => ACTIVE.has(t.status) || Targets.pending(t)).map(t => t.symbol))],
      snapshot: () => ({ version: 1, settings: { ...config }, trades, ...(ignoreBefore > 0 ? { ignoreBefore } : {}) }) };
  }
  const api = { createModel, DEFAULTS, MAX_GAP_MS, CLOSED };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.PaperEngine = api;
})(typeof window !== "undefined" ? window : globalThis);
