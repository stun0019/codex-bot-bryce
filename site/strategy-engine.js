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
      bars.push({ openTime, closeTime, open, high, low, close });
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

  function position(candidate, market, capital = SETTINGS.capital) {
    const budget = capital * SETTINGS.riskFraction;
    if (!(capital > 0) || !Number.isFinite(capital)) return { ok: false, reason: "總資金無效" };
    const distance = Math.abs(candidate.entry - candidate.stopLoss);
    const step = Number(market.stepSize), minQty = Number(market.minQty || 0), maxQty = Number(market.maxQty || Infinity);
    if (!(distance > 0) || !(step > 0)) return { ok: false, reason: "停損距離或數量精度無效" };
    let quantity = quantize(Math.min(budget / distance, maxQty), step, "floor");
    // A rounded quantity must never exceed the configured price-risk budget.
    if (quantity * distance > budget) quantity = Number((quantity - step).toFixed(Math.min(14, decimals(step))));
    const notional = quantity * candidate.entry, risk = quantity * distance;
    if (!(quantity > 0) || quantity < minQty || notional < Number(market.minNotional || 0)) {
      return { ok: false, reason: "風險預算內的部位未達幣安最小下單要求", budget };
    }
    return { ok: true, capital, budget, quantity, notional, risk,
      profit: quantity * Math.abs(candidate.target - candidate.entry),
      rewardRisk: Math.abs(candidate.target - candidate.entry) / distance };
  }

  const api = { INTERVALS, SETTINGS, closedBars, ma, position, decimals, quantize, targets };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.StrategyEngine = api;
})(typeof window !== "undefined" ? window : globalThis);
