// Binance USDⓈ-M perpetual market data. Load before app.js.
// Keep the CatPriceFeed interface and BASE-USDT keys used by existing orders.
// Routed sockets: /market for trades/tickers, /public for best bid/ask.
(function () {
  "use strict";

  const REST_URL = "https://fapi.binance.com";
  const STALE_MS = 30000;
  const supported = typeof window.WebSocket === "function";
  const aliases = { PEPE: "1000PEPE", BONK: "1000BONK", SHIB: "1000SHIB",
    FLOKI: "1000FLOKI", LUNC: "1000LUNC", XEC: "1000XEC", SATS: "1000SATS",
    RATS: "1000RATS", CAT: "1000CAT", CHEEMS: "1000CHEEMS" };
  const owners = { page: new Set(), market: new Set(), scanner: new Set() };
  const prices = new Map(), tickers = new Map(), books = new Map();
  const tickListeners = new Set();
  const listeners = new Set(), pendingJump = new Map(), restAt = new Map();
  const restPending = new Map(), unsupported = new Set(), refs = new Map();
  const conns = [];
  let wanted = new Set(), catalog = null, catalogPending = null, catalogAt = 0;
  let catalogRetryAt = 0, lastError = "", syncTimer = null, flushTimer = null;
  let batch = new Map(), nextId = 1;

  function normalizePair(value) {
    const raw = String(value || "").trim().toUpperCase().replace(/[\s/_-]/g, "");
    if (!/^[A-Z0-9]+$/.test(raw)) return "";
    const base = raw.endsWith("USDT") ? raw.slice(0, -4) : raw;
    return base ? base + "-USDT" : "";
  }

  function number(value) {
    if (value == null || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  async function request(path) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(REST_URL + path, { cache: "no-store", signal: controller.signal });
      const data = await response.json();
      if (!response.ok || Number(data.code) < 0) {
        const error = new Error(data.msg || "Binance HTTP " + response.status);
        error.code = data.code;
        throw error;
      }
      return data;
    } finally { clearTimeout(timer); }
  }

  async function ensureCatalog() {
    if (catalog && Date.now() - catalogAt < 3600000) return catalog;
    if (catalogPending) return catalogPending;
    if (Date.now() < catalogRetryAt) {
      if (catalog) return catalog;
      throw new Error(lastError || "Binance contract list unavailable");
    }
    catalogPending = (async () => {
      try {
        const data = await request("/fapi/v1/exchangeInfo");
        if (!Array.isArray(data.symbols) || !data.symbols.length) throw new Error("Binance contract list missing");
        catalog = new Map(data.symbols.filter(item => item.contractType === "PERPETUAL" &&
          item.quoteAsset === "USDT" && item.status === "TRADING").map(item => [item.symbol, item]));
        catalogAt = Date.now();
        catalogRetryAt = 0;
        lastError = "";
        return catalog;
      } catch (error) {
        lastError = String(error.message || error);
        catalogRetryAt = Date.now() + 60000;
        if (catalog) return catalog;
        throw error;
      } finally { catalogPending = null; }
    })();
    return catalogPending;
  }

  function contract(pair) {
    if (!catalog) return null;
    const base = pair.slice(0, -5), direct = base + "USDT";
    if (catalog.has(direct)) return { symbol: direct, multiplier: 1 };
    const alias = aliases[base];
    if (alias && catalog.has(alias + "USDT")) {
      return { symbol: alias + "USDT", multiplier: Number(alias.slice(0, -base.length)) };
    }
    return null;
  }

  function flush() {
    flushTimer = null;
    const out = batch;
    batch = new Map();
    listeners.forEach(fn => { try { fn(out); } catch (_) { /* isolate listeners */ } });
  }

  function acceptTick(pair, raw, source, timestamp = Date.now(), metadata = {}) {
    const price = number(raw), now = Date.now(), prev = prices.get(pair);
    if (!(price > 0) || !Number.isFinite(timestamp) || timestamp <= 0 ||
        timestamp > now + 30000 || now - timestamp > STALE_MS ||
        (prev && timestamp < prev.timestamp && metadata.kind !== "aggTrade")) return false;
    // Paper execution observes each valid exchange quote before UI jump filtering or batching.
    tickListeners.forEach(fn => { try { fn({ pair, price, at: now, timestamp, source, ...metadata }); } catch (_) { /* isolate */ } });
    if (prev && timestamp < prev.timestamp) return false;
    if (prev && now - prev.at < 60000 && Math.abs(price / prev.price - 1) > 0.25) {
      const candidate = pendingJump.get(pair);
      if (!candidate || (Math.abs(price / candidate.price - 1) >= 0.1 && now - candidate.at <= 10000)) {
        if (!candidate) pendingJump.set(pair, { price, at: now });
        return false;
      }
    }
    pendingJump.delete(pair);
    const rec = { price, at: now, timestamp, source };
    prices.set(pair, rec);
    batch.set(pair, rec);
    if (!flushTimer) flushTimer = setTimeout(flush, 1000);
    return true;
  }

  function consume(message, route) {
    const data = message && (message.data || message);
    if (!data || !data.s || (data.st != null && Number(data.st) !== 1)) return;
    const symbol = String(data.s).toUpperCase();
    const now = Date.now(), timestamp = number(data.E ?? data.T);
    if (!(timestamp > 0) || timestamp > now + 30000 || now - timestamp > STALE_MS) return;
    for (const ref of refs.get(symbol) || []) {
      const { pair, multiplier } = ref;
      if (data.e === "aggTrade" && route === "market") {
        acceptTick(pair, number(data.p) / multiplier, "ws", number(data.T ?? data.E), { kind: "aggTrade", aggregateId: number(data.a), nativeSymbol: symbol });
      } else if (data.e === "24hrTicker" && route === "market") {
        const previous = tickers.get(pair);
        if (previous && timestamp < previous.timestamp) continue;
        const scaled = key => number(data[key]) == null ? null : number(data[key]) / multiplier;
        tickers.set(pair, { price: scaled("c"), baseVolume24h: number(data.v) == null ? null : number(data.v) * multiplier,
          high24h: scaled("h"), low24h: scaled("l"), changePct: number(data.P), timestamp, at: now });
        acceptTick(pair, scaled("c"), "ws", timestamp);
      } else if (data.e === "bookTicker" && route === "public") {
        const previous = books.get(pair), bookTime = number(data.T ?? data.E);
        if (previous && bookTime < previous.timestamp) continue;
        books.set(pair, { bid: number(data.b) == null ? null : number(data.b) / multiplier,
          ask: number(data.a) == null ? null : number(data.a) / multiplier, timestamp: bookTime, at: now });
      }
    }
  }

  function send(conn, method, params) {
    if (!conn.ws || conn.ws.readyState !== WebSocket.OPEN) return false;
    try {
      conn.ws.send(JSON.stringify({ method, ...(params ? { params } : {}), id: nextId++ }));
      return true;
    } catch (_) { return false; }
  }

  // Coalesce all owner changes into at most two control messages per socket per 300ms.
  function scheduleControl(conn) {
    if (conn.controlTimer) return;
    conn.controlTimer = setTimeout(() => {
      conn.controlTimer = null;
      if (!conn.ws || conn.ws.readyState !== WebSocket.OPEN) return;
      const remove = [...conn.active].filter(stream => !conn.desired.has(stream));
      const add = [...conn.desired].filter(stream => !conn.active.has(stream));
      if (remove.length && send(conn, "UNSUBSCRIBE", remove)) remove.forEach(stream => conn.active.delete(stream));
      if (add.length && send(conn, "SUBSCRIBE", add)) add.forEach(stream => conn.active.add(stream));
    }, 300);
  }

  function detach(conn) {
    const ws = conn.ws;
    conn.ws = null;
    conn.active.clear();
    conn.probeAt = 0;
    if (conn.controlTimer) clearTimeout(conn.controlTimer);
    conn.controlTimer = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try { ws.close(); } catch (_) { /* already closed */ }
    }
  }

  function reconnect(conn) {
    if (!conn.desired.size || conn.retryTimer) return;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(conn.attempts++, 5));
    conn.retryTimer = setTimeout(() => { conn.retryTimer = null; open(conn); }, delay);
  }

  function open(conn) {
    if (!conn.desired.size || conn.ws) return;
    let ws;
    try { ws = new WebSocket("wss://fstream.binance.com/" + conn.route + "/stream"); }
    catch (_) { reconnect(conn); return; }
    conn.ws = ws;
    conn.lastMessageAt = conn.openedAt = Date.now();
    ws.onopen = () => {
      if (conn.ws !== ws) return;
      conn.attempts = 0;
      scheduleControl(conn);
    };
    ws.onmessage = event => {
      if (conn.ws !== ws) return;
      let msg;
      try { msg = JSON.parse(event.data); } catch (_) { return; }
      conn.lastMessageAt = Date.now();
      conn.probeAt = 0;
      if (msg.id != null) {
        if (msg.code != null) {
          lastError = "Binance WebSocket: " + msg.msg;
          detach(conn);
          reconnect(conn);
        }
        return;
      }
      consume(msg, conn.route);
    };
    ws.onclose = () => { if (conn.ws === ws) { detach(conn); reconnect(conn); } };
    ws.onerror = () => { if (conn.ws === ws) { detach(conn); reconnect(conn); } };
  }

  async function sync() {
    try { await ensureCatalog(); } catch (_) { return; }
    unsupported.clear();
    refs.clear();
    const routes = { market: new Set(), public: new Set() };
    for (const pair of wanted) {
      const info = contract(pair);
      if (!info) {
        unsupported.add(pair);
        prices.delete(pair); tickers.delete(pair); books.delete(pair); batch.delete(pair);
        continue;
      }
      const entries = refs.get(info.symbol) || [];
      entries.push({ pair, ...info });
      refs.set(info.symbol, entries);
      const stream = info.symbol.toLowerCase();
      routes.market.add(stream + "@aggTrade");
      if (owners.market.has(pair) || owners.scanner.has(pair)) routes.market.add(stream + "@ticker");
      if (owners.scanner.has(pair)) routes.public.add(stream + "@bookTicker");
    }
    if (!supported) return;
    for (const route of ["market", "public"]) {
      const streams = [...routes[route]];
      const count = Math.ceil(streams.length / 900);
      for (let index = 0; index < Math.max(count, ...conns.filter(c => c.route === route).map(c => c.index + 1), 0); index++) {
        let conn = conns.find(c => c.route === route && c.index === index);
        if (!conn) {
          conn = { route, index, ws: null, active: new Set(), desired: new Set(), attempts: 0,
            retryTimer: null, controlTimer: null, probeAt: 0, lastMessageAt: 0, openedAt: 0 };
          conns.push(conn);
        }
        conn.desired = new Set(streams.slice(index * 900, (index + 1) * 900));
        if (!conn.desired.size) {
          if (conn.retryTimer) clearTimeout(conn.retryTimer);
          conn.retryTimer = null;
          detach(conn);
        } else if (conn.ws) scheduleControl(conn);
        else if (!conn.retryTimer) open(conn);
      }
    }
  }

  function scheduleSync() {
    if (!syncTimer) syncTimer = setTimeout(() => { syncTimer = null; void sync(); }, 0);
  }

  function setOwner(owner, list) {
    owners[owner] = new Set((Array.isArray(list) ? list : []).map(normalizePair).filter(Boolean));
    wanted = new Set([...owners.page, ...owners.market, ...owners.scanner]);
    for (const pair of prices.keys()) if (!wanted.has(pair)) { prices.delete(pair); pendingJump.delete(pair); batch.delete(pair); }
    for (const pair of tickers.keys()) if (!owners.market.has(pair) && !owners.scanner.has(pair)) tickers.delete(pair);
    for (const pair of books.keys()) if (!owners.scanner.has(pair)) books.delete(pair);
    scheduleSync();
  }

  function want(value) {
    const pair = normalizePair(value);
    if (pair && !owners.page.has(pair)) setOwner("page", [...owners.page, pair]);
  }

  function get(symbol) {
    const pair = normalizePair(symbol), rec = prices.get(pair);
    return rec ? { pair, ...rec, fresh: Date.now() - rec.timestamp < STALE_MS } : null;
  }

  async function restPrice(pair) {
    if (restPending.has(pair)) return restPending.get(pair);
    const pending = (async () => {
      await ensureCatalog();
      const info = contract(pair);
      if (!info || unsupported.has(pair)) { unsupported.add(pair); throw new Error("Binance contract unavailable"); }
      if (Date.now() - (restAt.get(pair) || 0) < 15000) throw new Error("Binance price temporarily unavailable");
      restAt.set(pair, Date.now());
      try {
        const data = await request("/fapi/v2/ticker/price?symbol=" + encodeURIComponent(info.symbol));
        const value = number(data.price) / info.multiplier;
        if (!acceptTick(pair, value, "rest", number(data.time))) throw new Error("Binance price missing, stale or unconfirmed");
        return value;
      } catch (error) {
        if (Number(error.code) === -1121) {
          unsupported.add(pair); prices.delete(pair); tickers.delete(pair); books.delete(pair);
          catalogAt = 0;
          scheduleSync();
        }
        throw error;
      }
    })();
    restPending.set(pair, pending);
    try { return await pending; } finally { restPending.delete(pair); }
  }

  async function price(symbol) {
    const pair = normalizePair(symbol);
    if (!pair) throw new Error("Invalid symbol");
    await ensureCatalog();
    if (!contract(pair)) { unsupported.add(pair); throw new Error("Binance contract unavailable"); }
    want(pair);
    const cached = get(pair);
    if (cached && cached.fresh) return cached.price;
    return restPrice(pair);
  }

  function getTicker(symbol) {
    const rec = tickers.get(normalizePair(symbol));
    return rec ? { ...rec, fresh: Date.now() - rec.at < 20000 && Date.now() - rec.timestamp < 20000 } : null;
  }

  function getBookTicker(symbol) {
    const rec = books.get(normalizePair(symbol)), now = Date.now();
    if (!rec) return null;
    return { ...rec, fresh: rec.bid > 0 && rec.ask >= rec.bid && rec.timestamp > 0 &&
      rec.timestamp <= now + 30000 && now - rec.timestamp < 10000 && now - rec.at < 10000 };
  }

  async function listSymbols() {
    await ensureCatalog();
    const symbols = new Set([...catalog.keys()]);
    for (const base of Object.keys(aliases)) if (contract(base + "-USDT")) symbols.add(base + "USDT");
    return [...symbols].sort();
  }

  function watchdog() {
    if (wanted.size && (!catalog || Date.now() - catalogAt >= 3600000) && Date.now() >= catalogRetryAt) scheduleSync();
    for (const conn of conns) {
      if (!conn.ws) continue;
      const now = Date.now();
      if ((conn.ws.readyState === WebSocket.CONNECTING && now - conn.openedAt > 15000) ||
          (conn.probeAt && now - conn.probeAt > 15000) || now - conn.openedAt > 23 * 3600000) {
        detach(conn); reconnect(conn);
      } else if (conn.ws.readyState === WebSocket.OPEN && now - conn.lastMessageAt > 30000 && !conn.probeAt) {
        if (send(conn, "LIST_SUBSCRIPTIONS")) conn.probeAt = now;
      }
    }
  }

  if (supported) {
    setInterval(watchdog, 5000);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { watchdog(); scheduleSync(); } });
    window.addEventListener("online", scheduleSync);
  }

  window.CatPriceFeed = {
    supported, STALE_MS, normalizePair, want, get, price, getTicker, getBookTicker, listSymbols,
    setSymbols: list => setOwner("page", list),
    setMarketSymbols: list => setOwner("market", list),
    setScannerSymbols: list => setOwner("scanner", list),
    isUnsupported: symbol => unsupported.has(normalizePair(symbol)),
    subscribeTicks(fn) { if (typeof fn === "function") tickListeners.add(fn); return () => tickListeners.delete(fn); },
    subscribe(fn) { if (typeof fn === "function") listeners.add(fn); return () => listeners.delete(fn); },
    status() { return { supported, exchange: "Binance", wanted: wanted.size, prices: prices.size,
      lastError, unsupported: [...unsupported], connections: conns.filter(c => c.desired.size).map(c => ({
        route: c.route, openedAt: c.openedAt, state: c.ws ? c.ws.readyState : -1, subscribed: c.active.size,
        silentMs: c.lastMessageAt ? Date.now() - c.lastMessageAt : null })) }; }
  };
})();
