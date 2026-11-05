(function (root) {
  "use strict";
  const INTERVALS = Object.freeze({ "4h": 14400000, "1h": 3600000, "15m": 900000, "5m": 300000 });
  const SETTINGS = Object.freeze({ capital: 200, riskFraction: 0.05, rewardRisk: 2, klineLimit: 499 });

  function closedBars(rows, interval, now) {
    const duration = INTERVALS[interval];
    if (!duration || !Array.isArray(rows) || !Number.isFinite(now)) throw new Error("Unsupported or invalid candle data");
    const bars = [];
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 7) throw new Error("Incomplete candle data");
      const [openTime, open, high, low, close, volume, closeTime] = row.slice(0, 7).map(Number);
      if (!Number.isFinite(openTime) || !Number.isFinite(closeTime)) throw new Error("Invalid candle timestamp");
      if (closeTime >= now) continue; // Never use an unfinished bar.
      if (![open, high, low, close].every(value => Number.isFinite(value) && value > 0) ||
          high < Math.max(open, close) || low > Math.min(open, close) || high < low ||
          openTime % duration !== 0 || closeTime !== openTime + duration - 1) throw new Error("Invalid OHLC candle");
      if (bars.length && openTime !== bars[bars.length - 1].openTime + duration) throw new Error("Candle gap or duplicate");
      if (row[5] == null || row[5] === "" || !Number.isFinite(volume) || volume < 0) throw new Error("Invalid candle volume");
      bars.push({ openTime, closeTime, open, high, low, close, volume });
    }
    const expectedClose = Math.floor(now / duration) * duration - 1;
    if (!bars.length || bars[bars.length - 1].closeTime !== expectedClose) throw new Error("Candle data is stale");
    return bars;
  }

  function ma(bars, period, index = bars.length - 1) {
    if (index < period - 1) return null;
    let sum = 0;
    for (let i = index - period + 1; i <= index; i++) sum += bars[i].close;
    return sum / period;
  }

  function decimals(step) {
    const [coefficient, exponent = "0"] = String(step).toLowerCase().split("e");
    return Math.max(0, (coefficient.split(".")[1] || "").length - Number(exponent));
  }

  function quantize(value, step, direction) {
    const factor = value / step;
    // Correct representational error at exact tick boundaries before rounding.
    const nearest = Math.round(factor);
    const normalized = Math.abs(factor - nearest) <= Math.abs(factor) * Number.EPSILON * 4 ? nearest : factor;
    return Number((Math[direction](normalized) * step).toFixed(Math.min(14, decimals(step))));
  }

  function targets(entry, stopLoss, direction, tick, count = 4) {
    const long = direction === "LONG", distance = Math.abs(entry - stopLoss);
    return [2, 3, 4, 5].slice(0, count).map(rr => {
      let value = quantize(entry + (long ? 1 : -1) * distance * rr, tick, long ? "ceil" : "floor");
      if (Math.abs(value - entry) / distance < rr) value = Number((value + (long ? tick : -tick)).toFixed(Math.min(14, decimals(tick))));
      return value > 0 ? value : null;
    });
  }

  function partialQuantities(quantity,step,fractions=[.3,.3,.4]) {
    if(!Array.isArray(fractions)||![3,4].includes(fractions.length)||fractions.some(f=>!Number.isFinite(f)||f<=0)||Math.abs(fractions.reduce((s,f)=>s+f,0)-1)>1e-10||!(quantity>0)||!(step>0))return [];
    const result=fractions.slice(0,-1).map(f=>quantize(quantity*f,step,"floor"));
    result.push(Number((quantity-result.reduce((sum,q)=>sum+q,0)).toFixed(Math.min(14,decimals(step)))));return result;
  }
  function position(candidate, market, capital = SETTINGS.capital, options = {}) {
    const feeRate = options.feeRate ?? .0005, slippage = options.slippage ?? .0002;
    const fraction = options.riskFraction ?? candidate.riskFraction ?? SETTINGS.riskFraction;
    const budget = options.budget ?? capital * fraction, entry = Number(options.entry ?? candidate.entry), stop = Number(candidate.stopLoss);
    const long = candidate.direction ? candidate.direction === "LONG" : stop < entry;
    const step = Number(market.stepSize), tick = Number(candidate.tickSize ?? market.tickSize);
    const minQty = Number(market.minQty ?? 0), maxQty = Number(market.maxQty ?? Infinity), minNotional = Number(market.minNotional ?? 0), leverage = options.leverage ?? 50;
    const blocked = reason => ({ ok: false, reason, capital, budget });
    if (!(capital > 0) || !Number.isFinite(capital)) return blocked("總資金無效");
    if (![entry, stop, step, tick, budget, feeRate, slippage, fraction, leverage, minQty, minNotional].every(Number.isFinite) || !(entry > 0) || !(stop > 0) || !(step > 0) || !(tick > 0) || !(budget > 0) || feeRate < 0 || feeRate > .01 || slippage < 0 || slippage > .01 || fraction <= 0 || fraction > 1 || leverage < 1 || leverage > 125 || !(maxQty > 0) || minQty < 0 || minNotional < 0) return blocked("部位計算參數無效或風險額度不足");
    const target = Number(candidate.target), distance = Math.abs(entry - stop);
    if (!Number.isFinite(target) || (candidate.direction && !["LONG","SHORT"].includes(candidate.direction)) || !(distance > 0) || (long ? stop >= entry || target <= entry : stop <= entry || target >= entry)) return blocked("進場報價已越過停損或目標");
    const rewardRisk = Math.abs(target - entry) / distance;
    if (rewardRisk < 2) return blocked("實際模擬進場的價差盈虧比不足 1:2");
    const stopFill = quantize(stop * (long ? 1 - slippage : 1 + slippage), tick, long ? "floor" : "ceil");
    if (!(stopFill > 0)) return blocked("估算停損成交價無效");
    const riskPerUnit = Math.abs(entry - stopFill) + (entry + stopFill) * feeRate;
    if(candidate.targetMode==="FIB"){
      const targetFill=quantize(target*(long?1-slippage:1+slippage),tick,long?"floor":"ceil"),netReward=(targetFill-entry)*(long?1:-1)-(entry+targetFill)*feeRate;
      if(netReward/riskPerUnit<2)return blocked("TP1含估算費用與滑價的盈虧比不足1:2");
    }
    const cap = Math.min(maxQty, options.maxQuantity ?? Infinity);
    let quantity = options.quantity ?? quantize(Math.min(budget / riskPerUnit, cap), step, "floor");
    if (options.quantity === undefined && quantity * riskPerUnit > budget) quantity = Number((quantity - step).toFixed(Math.min(14, decimals(step))));
    if (!Number.isFinite(quantity) || !(quantity > 0) || quantity > cap || Math.abs(quantity - quantize(quantity, step, "floor")) > step * 1e-7 || quantity * riskPerUnit > budget + 1e-9) return blocked("含估算費用的風險預算不足幣安最小部位");
    const notional = quantity * entry;
    if (quantity < minQty || notional < minNotional) return blocked("含估算費用的風險預算不足幣安最小部位");
    const partial = options.partialExit ?? !!candidate.partialExit;
    let exitQuantities = [quantity], exitPrices = [target];
    if (partial) {
      const fractions=candidate.exitFractions||[.3,.3,.4];
      exitQuantities=partialQuantities(quantity,step,fractions); exitPrices=[...(candidate.targets||candidate.plannedTargets||targets(entry,stop,long?"LONG":"SHORT",tick))].slice(0,fractions.length);
      if (!exitQuantities.length || exitQuantities.some(q => !(q > 0) || q < minQty) || exitPrices.length !== exitQuantities.length || exitPrices.some(p => !Number.isFinite(p) || !(p > 0) || (long ? p <= entry : p >= entry))) return blocked("部位不足以依設定比例分批出場");
    }
    const entryFee = notional * feeRate, stopExitFee = quantity * stopFill * feeRate, initialMargin = notional / leverage;
    const grossProfit = exitQuantities.reduce((sum, q, i) => {const price = quantize(exitPrices[i] * (long ? 1 - slippage : 1 + slippage), tick, long ? "floor" : "ceil");return sum + (price - entry) * q * (long ? 1 : -1) - price * q * feeRate;}, 0);
    return { ok: true, capital, budget, entry, stopFill, quantity, notional, risk: quantity * riskPerUnit, riskPerUnit, rewardRisk,
      entryFee, stopExitFee, initialMargin, feeReserve: entryFee + stopExitFee, marginReserve: initialMargin + entryFee + stopExitFee,
      profit: grossProfit - entryFee, exitQuantities, exitPrices, feeRate, slippage, leverage, partialExit: partial };
  }

  const api = { INTERVALS, SETTINGS, closedBars, ma, position, partialQuantities, decimals, quantize, targets };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.StrategyEngine = api;
})(typeof window !== "undefined" ? window : globalThis);
