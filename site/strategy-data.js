(function (root) {
  "use strict";
  const BASE = "https://fapi.binance.com";
  const Engine = root.StrategyEngine || (typeof require === "function" ? require("./strategy-engine.js") : null);
  const Signal = root.MacdStrategy || (typeof require === "function" ? require("./macd-engine.js") : null);
  function createClient({ fetcher = root.fetch.bind(root), intervalMs = 250, concurrency = 3,
      clock = () => Date.now(), sleep = (ms, signal) => new Promise((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
        const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
        if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
      }) } = {}) {
    let nextRequestAt = 0, backoffUntil = 0, catalog = null, catalogAt = 0;
    const cache = new Map();
    async function json(path, signal) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (clock() < backoffUntil) { const error = new Error("幣安請求限流，稍後自動重試"); error.retryAt = backoffUntil; throw error; }
      const start = Math.max(nextRequestAt, clock());
      nextRequestAt = start + intervalMs;
      if (start > clock()) await sleep(start - clock(), signal);
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (clock() < backoffUntil) { const error = new Error("幣安請求限流，稍後自動重試"); error.retryAt = backoffUntil; throw error; }
      const controller = new AbortController(), abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, 10000);
      try {
        const response = await fetcher(BASE + path, { signal: controller.signal, cache: "no-store" });
        if (response.status === 429 || response.status === 418) {
          const retry = response.headers?.get("retry-after"), seconds = Number(retry);
          const parsedDate = retry ? Date.parse(retry) : NaN;
          const delay = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 :
            Number.isFinite(parsedDate) ? parsedDate - clock() : 60000;
          backoffUntil = clock() + Math.max(60000, delay);
          const error = new Error("幣安請求限流，稍後自動重試"); error.retryAt = backoffUntil; throw error;
        }
        const data = await response.json();
        if (!response.ok || Number(data.code) < 0) throw new Error(data.msg || "Binance HTTP " + response.status);
        return data;
      } catch (error) {
        if (controller.signal.aborted && !signal?.aborted) throw new Error("幣安請求逾時");
        throw error;
      } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
    }

    async function markets(signal) {
      if (catalog && clock() - catalogAt < 1800000) return catalog;
      const data = await json("/fapi/v1/exchangeInfo", signal);
      if (!Array.isArray(data.symbols) || !data.symbols.length) throw new Error("無法取得幣安合約清單");
      catalog = data.symbols.filter(item => item.quoteAsset === "USDT" && item.contractType === "PERPETUAL" && item.status === "TRADING")
        .map(item => {
          const filter = type => (item.filters || []).find(f => f.filterType === type) || {};
          const lot = filter("LOT_SIZE"), notional = filter("MIN_NOTIONAL");
          return { symbol: item.symbol, tickSize: Number(filter("PRICE_FILTER").tickSize), stepSize: Number(lot.stepSize),
            minQty: Number(lot.minQty), maxQty: Number(lot.maxQty), minNotional: Number(notional.notional ?? notional.minNotional ?? 0) };
        }).filter(item => item.tickSize > 0 && item.stepSize > 0)
        .sort((a, b) => a.symbol.localeCompare(b.symbol));
      if (!catalog.length) throw new Error("沒有符合條件的 USDT 永續合約");
      catalogAt = clock();
      return catalog;
    }

    async function topMarkets(signal) {
      const listed = await markets(signal);
      const rows = await json("/fapi/v1/ticker/24hr", signal);
      if (!Array.isArray(rows)) throw new Error("無法取得幣安 24 小時成交額排名");
      const volumes = new Map();
      for (const row of rows) {
        if (!row || row.quoteVolume == null || row.quoteVolume === "" ||
            (row.st != null && Number(row.st) !== 1)) continue;
        const volume = Number(row.quoteVolume);
        if (Number.isFinite(volume) && volume > 0) volumes.set(row.symbol, Math.max(volume, volumes.get(row.symbol) || 0));
      }
      const ranked = listed.filter(market => volumes.has(market.symbol))
        .map(market => ({ ...market, quoteVolume24h: volumes.get(market.symbol) }))
        .sort((a, b) => b.quoteVolume24h - a.quoteVolume24h || a.symbol.localeCompare(b.symbol))
        .slice(0, 20);
      if (!ranked.length) throw new Error("沒有有效的 USDT 永續合約成交額資料");
      return ranked;
    }

    async function candles(symbol, interval, asOf, signal) {
      if (!Object.hasOwn(Engine.INTERVALS, interval)) throw new Error("只允許 EMA 的 4H／15M、1H／5M K 線");
      const bucket = Math.floor(asOf / Engine.INTERVALS[interval]), key = symbol + ":" + interval;
      const previous = cache.get(key);
      if (previous?.bucket === bucket) return previous.bars;
      const rows = await json("/fapi/v1/klines?symbol=" + encodeURIComponent(symbol) + "&interval=" + interval +
        "&limit=" + Engine.SETTINGS.klineLimit + "&endTime=" + Math.floor(asOf - 1), signal);
      const bars = Engine.closedBars(rows, interval, asOf);
      cache.set(key, { bucket, bars });
      return bars;
    }

    async function scan({ capital = Engine.SETTINGS.capital, rsiFilter = false, signal, onProgress = () => {} } = {}) {
      const time = await json("/fapi/v1/time", signal), asOf = Number(time.serverTime);
      if (!Number.isFinite(asOf) || asOf <= 0) throw new Error("幣安時間無效");
      const localAt = clock(), universe = await topMarkets(signal), candidates = [], profiles = Object.values(Signal.PROFILES);
      const tasks = universe.flatMap(market => profiles.map(profile => ({ market, profile })));
      const state = { strategyVersion: Signal.VERSION, filters: {macd:[12,26,9],entryPolicy:"macd-alignment-candidate-only",rsiFilter:!!rsiFilter}, total: tasks.length, completed: 0, trending: 0, errors: 0, candidates, asOf,
        serverOffset: asOf - localAt, symbols: universe.map(m => m.symbol), rankedMarkets: universe.map(m => ({ ...m })), observations: [], failures: [] };
      onProgress({ ...state }); let cursor = 0, fatal = null;
      await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
        while (cursor < tasks.length && !fatal) {
          if (signal?.aborted) { fatal = new DOMException("Aborted", "AbortError"); break; }
          const { market, profile } = tasks[cursor++];
          const observation = { symbol: market.symbol, profileId: profile.id, timeframeLabel: profile.label, quoteVolume24h: market.quoteVolume24h, status: "WAIT_PULLBACK", direction: null, reason: "等待MACD同向及15M回抽確認" };
          try {
            const higher = await candles(market.symbol, profile.high, asOf, signal);
            const lower = await candles(market.symbol, profile.low, asOf, signal);
            const result = Signal.analyze(market, higher, lower, asOf, capital, profile.id, {rsiFilter});
            Object.assign(observation, { emaTrend: result.trend, macdLow: result.macdLow, entryFilter: result.entryFilter, status: result.status, reason: result.reason, direction: result.direction || result.pending?.direction || null });
            if (result.trend?.direction) state.trending++;
            if (result.pending) { candidates.push(result.pending); observation.status = "CANDIDATE"; }
          } catch (error) {
            observation.status = "ERROR"; observation.reason = error.message;
            if (error.name === "AbortError" || error.retryAt) fatal = error;
            else { state.errors++; state.failures.push({ symbol: market.symbol, profileId: profile.id, message: error.message }); }
          }
          state.observations.push(observation); state.completed++;
          onProgress({ ...state, candidates: [...candidates] });
        }
      }));
      if (fatal) throw fatal;
      return { ...state, candidates: [...candidates].sort((a,b) => a.symbol.localeCompare(b.symbol) || a.profileId.localeCompare(b.profileId)) };
    }
    return { scan, markets, topMarkets, candles, getBackoffUntil: () => backoffUntil };
  }
  const api = { createClient };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.StrategyData = api;
})(typeof window !== "undefined" ? window : globalThis);
