(function (root) {
  "use strict";

  const FACTORS = ["liquidity", "spread", "volatility", "relativeStrength", "momentum"];
  const finite = (value) => typeof value === "number" && Number.isFinite(value);
  const clamp = (value, min = 0, max = 100) => Math.min(max, Math.max(min, value));
  const smoothstep = (start, end, value) => {
    const t = clamp((value - start) / (end - start), 0, 1);
    return t * t * (3 - 2 * t);
  };

  function percentileMap(items, valueOf, ascending = true) {
    const sorted = items.filter((item) => finite(valueOf(item)))
      .sort((a, b) => ascending ? valueOf(a) - valueOf(b) : valueOf(b) - valueOf(a));
    const result = new Map();
    sorted.forEach((item, index) => {
      result.set(item.symbol, sorted.length === 1 ? 100 : 100 * index / (sorted.length - 1));
    });
    return result;
  }

  function volatilityScore(rangePct) {
    if (rangePct <= 2 || rangePct > 30) return 0;
    if (rangePct < 3) return 100 * smoothstep(2, 3, rangePct);
    if (rangePct <= 12) return 100;
    return 100 * (1 - smoothstep(12, 30, rangePct));
  }

  function momentumAt(history, now, lookbackMs, toleranceMs) {
    const current = history[history.length - 1];
    if (!current || !finite(current.price) || current.price <= 0 ||
        !finite(current.at) || now - current.at > toleranceMs) return null;
    const target = now - lookbackMs;
    let old = null;
    for (let i = history.length - 1; i >= 0; i--) {
      const sample = history[i];
      if (sample.at <= target) {
        old = sample;
        break;
      }
    }
    if (!old || target - old.at > toleranceMs || !finite(old.price) || old.price <= 0) return null;
    return (current.price / old.price - 1) * 100;
  }

  function stableOrder(rows, previousOrder, hysteresis) {
    if (!previousOrder || !previousOrder.length) return rows.sort((a, b) => b.score - a.score);
    const old = new Map(previousOrder.map((symbol, index) => [symbol, index]));
    rows.sort((a, b) => (old.has(a.symbol) ? old.get(a.symbol) : Infinity) -
      (old.has(b.symbol) ? old.get(b.symbol) : Infinity) || b.score - a.score);
    // A challenger crosses an incumbent only after a meaningful score lead.
    for (let pass = 0; pass < rows.length; pass++) {
      let moved = false;
      for (let i = 1; i < rows.length; i++) {
        if (rows[i].score > rows[i - 1].score + hysteresis) {
          [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]];
          moved = true;
        }
      }
      if (!moved) break;
    }
    return rows;
  }

  function evaluate(symbols, snapshots, config, now = Date.now(), previousOrder = []) {
    const btc = snapshots["BTC-USDT"] && snapshots["BTC-USDT"].ticker;
    const btcChangePct = btc && btc.fresh && finite(btc.changePct) ? btc.changePct : null;
    const candidates = [];
    let warming = 0;
    let filtered = 0;

    for (const symbol of symbols) {
      const snapshot = snapshots[symbol] || {};
      const ticker = snapshot.ticker;
      if (snapshot.unsupported) { filtered++; continue; }
      if (!ticker || !ticker.fresh || now - ticker.at > config.tickerStaleMs ||
          !finite(ticker.price) || ticker.price <= 0 ||
          !finite(ticker.baseVolume24h) || ticker.baseVolume24h <= 0 ||
          !finite(ticker.high24h) || !finite(ticker.low24h) ||
          ticker.low24h <= 0 || ticker.high24h < ticker.low24h) {
        warming++;
        continue;
      }
      const rangePct = (ticker.high24h - ticker.low24h) / ticker.low24h * 100;
      if (!finite(rangePct) || rangePct < 2 || rangePct > 30) { filtered++; continue; }
      const estimatedNotional = ticker.baseVolume24h * ticker.price;
      if (!finite(estimatedNotional) || estimatedNotional <= 0) { filtered++; continue; }
      const book = snapshot.book;
      const bookValid = book && book.fresh && now - book.at < config.bookStaleMs &&
        finite(book.bid) && book.bid > 0 && finite(book.ask) && book.ask >= book.bid &&
        finite(book.timestamp) && book.timestamp > 0 &&
        book.timestamp <= now + 30000 && now - book.timestamp < config.bookStaleMs;
      const bestBid = bookValid ? book.bid : null;
      const bestAsk = bookValid ? book.ask : null;
      const mid = bookValid ? (bestBid + bestAsk) / 2 : null;
      const spreadPct = mid > 0 ? (bestAsk - bestBid) / mid * 100 : null;
      if (finite(spreadPct) && spreadPct > config.maxSpreadPct) { filtered++; continue; }
      const changePct = finite(ticker.changePct) ? ticker.changePct : null;
      const relativeStrength = changePct != null && btcChangePct != null
        ? changePct - btcChangePct : null;
      const history = snapshot.history || [];
      const momentum1m = momentumAt(history, now, 60000, config.historyToleranceMs);
      const momentum5m = momentumAt(history, now, 300000, config.historyToleranceMs);
      candidates.push({
        symbol,
        factors: {
          liquidity: null,
          spread: null,
          volatility: volatilityScore(rangePct),
          relativeStrength: relativeStrength == null ? null :
            clamp(100 * (1 - Math.exp(-Math.abs(relativeStrength) / config.relativeStrengthScalePct))),
          momentum: momentum1m == null || momentum5m == null ? null :
            clamp(100 * (1 - Math.exp(-Math.abs(momentum1m * 0.4 + momentum5m * 0.6) /
              config.momentumScalePct)))
        },
        metrics: {
          price: ticker.price,
          baseVolume24h: ticker.baseVolume24h,
          estimatedNotional,
          high24h: ticker.high24h,
          low24h: ticker.low24h,
          rangePct,
          changePct,
          btcChangePct,
          relativeStrength,
          bestBid,
          bestAsk,
          spreadPct,
          momentum1m,
          momentum5m
        },
        bias: relativeStrength == null ? "NEUTRAL" :
          relativeStrength > config.biasThresholdPct ? "LONG BIAS" :
          relativeStrength < -config.biasThresholdPct ? "SHORT BIAS" : "NEUTRAL"
      });
    }

    const liquidityRanks = percentileMap(candidates, (row) => row.metrics.estimatedNotional);
    const useLiquidityFilter = candidates.length >= config.minMarketsForLiquidityFilter;
    const eligible = candidates.filter((row) => {
      const percentile = liquidityRanks.get(row.symbol) / 100;
      if (useLiquidityFilter && percentile < config.liquidityBottomPercentile) {
        filtered++;
        return false;
      }
      row.factors.liquidity = liquidityRanks.get(row.symbol);
      return true;
    });
    const spreadRanks = percentileMap(
      eligible.filter((row) => row.metrics.spreadPct != null),
      (row) => row.metrics.spreadPct,
      false
    );
    eligible.forEach((row) => {
      row.factors.spread = spreadRanks.get(row.symbol) ?? null;
      let weighted = 0;
      let availableWeight = 0;
      FACTORS.forEach((factor) => {
        const value = row.factors[factor];
        if (!finite(value)) return;
        weighted += value * config.weights[factor];
        availableWeight += config.weights[factor];
      });
      row.score = clamp(availableWeight > 0 ? weighted / availableWeight : 0);
      row.confidence = availableWeight >= 0.999 ? "HIGH" :
        availableWeight >= 0.75 ? "MEDIUM" : "LOW";
      row.provisional = availableWeight < 0.999;
    });
    stableOrder(eligible, previousOrder, config.rankHysteresisPoints);
    eligible.forEach((row, index) => { row.rank = index + 1; });
    return {
      results: eligible,
      warming,
      filtered,
      validMarkets: candidates.length,
      liquidityFilterActive: useLiquidityFilter,
      btcReady: btcChangePct != null
    };
  }

  const api = { evaluate, volatilityScore, momentumAt };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CodexRadarEngine = api;
})(typeof window !== "undefined" ? window : globalThis);
