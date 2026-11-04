(function (root) {
  "use strict";
  const Engine = root.StrategyEngine || (typeof require === "function" ? require("./strategy-engine.js") : null);
  const INTERVAL = 900000, PERIOD = 14, LIMIT = 250, BASE = "https://fapi.binance.com";
  function rsi(closes, period = PERIOD) {
    if (!Number.isInteger(period) || period < 1 || !Array.isArray(closes) || closes.length <= period ||
        closes.some(value => !Number.isFinite(value) || value <= 0)) throw new Error("RSI 歷史資料不足或無效");
    let gain = 0, loss = 0;
    for (let i = 1; i <= period; i++) { const change = closes[i] - closes[i - 1]; gain += Math.max(0, change); loss += Math.max(0, -change); }
    gain /= period; loss /= period;
    for (let i = period + 1; i < closes.length; i++) {
      const change = closes[i] - closes[i - 1];
      gain = (gain * (period - 1) + Math.max(0, change)) / period;
      loss = (loss * (period - 1) + Math.max(0, -change)) / period;
    }
    return loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
  }
  function evaluate(symbol, rows, asOf) {
    const bars = Engine.closedBars(rows, "15m", asOf);
    const volumes = new Map(rows.filter(row => Number(row[6]) < asOf).map(row => [Number(row[0]), row[5]]));
    for (const bar of bars) {
      const value = volumes.get(bar.openTime);
      if (value == null || value === "" || !Number.isFinite(Number(value)) || Number(value) < 0) throw new Error("成交量資料無效");
      bar.volume = Number(value);
    }
    const value = rsi(bars.map(bar => bar.close)), current = bars.at(-1), previous = bars.at(-2);
    // A zero baseline has no finite growth percentage and is never a match.
    const ratio = previous.volume > 0 ? current.volume / previous.volume : null;
    return { symbol, rsi: value, close: current.close, confirmedAt: current.closeTime + 1,
      volume: current.volume, previousVolume: previous.volume, volumeRatio: ratio,
      volumeGrowth: ratio == null ? null : (ratio - 1) * 100,
      matches: value < 30 && ratio != null && ratio >= 3 };
  }
  function createClient({ fetcher = root.fetch.bind(root), clock = () => Date.now(), intervalMs = 250, concurrency = 2,
    sleep = (ms, signal) => new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(new DOMException("Aborted", "AbortError")); };
      const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
      if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
    }) } = {}) {
    let nextAt = 0, backoffUntil = 0, running = false;
    const cache = new Map();
    async function json(path, signal) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const limited = () => { const error = new Error("幣安限流，請稍後更新"); error.retryAt = backoffUntil; return error; };
      if (clock() < backoffUntil) throw limited();
      const at = Math.max(nextAt, clock()); nextAt = at + intervalMs;
      if (at > clock()) await sleep(at - clock(), signal);
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (clock() < backoffUntil) throw limited();
      const controller = new AbortController(), abort = () => controller.abort(), timer = setTimeout(abort, 10000);
      signal?.addEventListener("abort", abort, { once: true });
      try {
        const response = await fetcher(BASE + path, { signal: controller.signal, cache: "no-store" });
        if (response.status === 429 || response.status === 418) {
          const retry = response.headers?.get("retry-after"), seconds = Number(retry), date = Date.parse(retry || "");
          backoffUntil = clock() + Math.max(60000, seconds > 0 ? seconds * 1000 : Number.isFinite(date) ? date - clock() : 60000);
          throw limited();
        }
        const data = await response.json();
        if (!response.ok || Number(data?.code) < 0) throw new Error(data?.msg || "Binance HTTP " + response.status);
        return data;
      } catch (error) {
        if (controller.signal.aborted && !signal?.aborted) throw new Error("幣安請求逾時");
        throw error;
      } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
    }
    async function scan({ signal, onProgress = () => {} } = {}) {
      if (running) throw new Error("RSI 掃描已在執行");
      running = true;
      try {
        const time = await json("/fapi/v1/time", signal), asOf = Number(time.serverTime);
        if (!Number.isFinite(asOf) || asOf <= 0) throw new Error("幣安時間無效");
        const info = await json("/fapi/v1/exchangeInfo", signal);
        if (!Array.isArray(info.symbols)) throw new Error("幣安合約清單無效");
        const symbols = [...new Set(info.symbols.filter(m => m.status === "TRADING" && m.quoteAsset === "USDT" && m.contractType === "PERPETUAL" &&
          typeof m.symbol === "string" && /^[A-Z0-9_]+USDT$/.test(m.symbol)).map(m => m.symbol))].sort();
        if (!symbols.length) throw new Error("沒有有效的 USDT 永續合約");
        const cutoff = Math.floor(asOf / INTERVAL) * INTERVAL;
        const state = { total: symbols.length, completed: 0, errors: 0, matches: [], failures: [], asOf, confirmedAt: cutoff, serverOffset: asOf - clock() };
        const publish = () => onProgress({ ...state, matches: [...state.matches], failures: [...state.failures] });
        for (const symbol of cache.keys()) if (!symbols.includes(symbol)) cache.delete(symbol);
        publish(); let cursor = 0, fatal = null;
        await Promise.all(Array.from({ length: Math.min(concurrency, symbols.length) }, async () => {
          while (cursor < symbols.length && !fatal) {
            if (signal?.aborted) { fatal = new DOMException("Aborted", "AbortError"); break; }
            const symbol = symbols[cursor++];
            try {
              let result = cache.get(symbol);
              if (!result || result.confirmedAt !== cutoff) {
                const rows = await json("/fapi/v1/klines?symbol=" + encodeURIComponent(symbol) + "&interval=15m&limit=" + LIMIT + "&endTime=" + (cutoff - 1), signal);
                result = evaluate(symbol, rows, asOf); cache.set(symbol, result);
              }
              if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
              if (result.matches) state.matches.push(result);
            } catch (error) {
              if (error.name === "AbortError" || error.retryAt) fatal = error;
              else { state.errors++; state.failures.push({ symbol, message: error.message }); }
            }
            state.completed++; publish();
          }
        }));
        if (fatal) throw fatal;
        return { ...state, matches: state.matches.sort((a, b) => a.rsi - b.rsi || a.symbol.localeCompare(b.symbol)) };
      } finally { running = false; }
    }
    return { scan, getBackoffUntil: () => backoffUntil };
  }
  const api = { rsi, evaluate, createClient, INTERVAL, PERIOD, LIMIT };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.RsiVolume = api;
})(typeof window !== "undefined" ? window : globalThis);
