(function (root) {
  "use strict";
  const INTERVALS = Object.freeze({ "4h": 14400000, "15m": 900000 });
  const SETTINGS = Object.freeze({ capital: 70, riskFraction: 0.03, rewardRisk: 2, klineLimit: 80 });

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

  function trend(bars) {
    if (!Array.isArray(bars) || bars.some(bar => bar.closeTime - bar.openTime + 1 !== INTERVALS["4h"])) throw new Error("Trend requires 4H candles");
    if (bars.length < 21) return null;
    const current = ma(bars, 20), previous = ma(bars, 20, bars.length - 2);
    const price = bars[bars.length - 1].close;
    if (price > current && current > previous) return "LONG";
    if (price < current && current < previous) return "SHORT";
    return null;
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

  function evaluate(market, fourHour, fifteenMinute, now, capital = SETTINGS.capital) {
    if (!Array.isArray(fifteenMinute) || fifteenMinute.some(bar => bar.closeTime - bar.openTime + 1 !== INTERVALS["15m"])) throw new Error("Entry requires 15M candles");
    if (!Number.isFinite(now) || !fourHour.length || !fifteenMinute.length ||
        fourHour[fourHour.length - 1].closeTime !== Math.floor(now / INTERVALS["4h"]) * INTERVALS["4h"] - 1 ||
        fifteenMinute[fifteenMinute.length - 1].closeTime !== Math.floor(now / INTERVALS["15m"]) * INTERVALS["15m"] - 1) throw new Error("Strategy requires the latest closed 4H and 15M candles");
    const direction = trend(fourHour);
    if (!direction || fifteenMinute.length < 21) return null;
    const last = fifteenMinute.length - 1, previous = fifteenMinute[last - 1], confirmation = fifteenMinute[last];
    const oldMa5 = ma(fifteenMinute, 5, last - 1), ma5 = ma(fifteenMinute, 5, last);
    const long = direction === "LONG";
    const reclaimed = long ? previous.close <= oldMa5 && confirmation.close > ma5 :
      previous.close >= oldMa5 && confirmation.close < ma5;
    if (!reclaimed) return null;
    const touches = index => [10, 20].some(period => {
      const average = ma(fifteenMinute, period, index), bar = fifteenMinute[index];
      return average != null && bar.low <= average && bar.high >= average;
    });
    // A single-bar retest or the immediately preceding retest may confirm the entry.
    const previousTouch = touches(last - 1), currentTouch = touches(last);
    if (!previousTouch && !currentTouch) return null;
    const tick = Number(market.tickSize);
    if (!(tick > 0)) throw new Error("Missing market tick size");
    const entry = confirmation.close;
    const retest = previousTouch ? [previous, confirmation] : [confirmation];
    const extreme = long ? Math.min(...retest.map(bar => bar.low)) : Math.max(...retest.map(bar => bar.high));
    const stopLoss = Number((quantize(extreme, tick, long ? "floor" : "ceil") + (long ? -tick : tick)).toFixed(Math.min(14, decimals(tick))));
    if (!(stopLoss > 0) || (long ? stopLoss >= entry : stopLoss <= entry)) return null;
    const distance = Math.abs(entry - stopLoss);
    let target = quantize(entry + (long ? 1 : -1) * distance * SETTINGS.rewardRisk, tick, long ? "ceil" : "floor");
    if (Math.abs(target - entry) / distance < SETTINGS.rewardRisk) target = Number((target + (long ? tick : -tick)).toFixed(Math.min(14, decimals(tick))));
    if (!(target > 0)) return null;
    const candidate = { symbol: market.symbol, direction, entry, stopLoss, target,
      tickSize: tick, stepSize: Number(market.stepSize), confirmedAt: confirmation.closeTime + 1,
      expiresAt: confirmation.closeTime + 1 + INTERVALS["15m"], trendAt: fourHour[fourHour.length - 1].closeTime + 1,
      ma4h20: ma(fourHour, 20), ma15m5: ma5, ma15m10: ma(fifteenMinute, 10), ma15m20: ma(fifteenMinute, 20) };
    if (candidate.expiresAt <= now) return null;
    candidate.plan = position(candidate, market, capital);
    return candidate;
  }

  const api = { INTERVALS, SETTINGS, closedBars, ma, trend, evaluate, position, decimals, quantize };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.StrategyEngine = api;
})(typeof window !== "undefined" ? window : globalThis);
