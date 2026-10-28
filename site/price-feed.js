// 貓眼策略：BingX 公開 WebSocket 即時價格模組（取代每 15 秒經 Vercel Function 代理的 REST 輪詢）。
//
// 載入順序：必須在 app.js 之前。app.js 透過 window.CatPriceFeed 取價。
//
// 協定（2026-10-14 實測）：
//   endpoint  wss://open-api-swap.bingx.com/swap-market
//   訊息為 GZIP 壓縮，用原生 DecompressionStream('gzip') 解（Safari 16.4+、Chrome 80+、Firefox 113+）
//   伺服器每 5 秒送 "Ping"（gzip 後的純字串），必須回 "Pong" 純字串，否則被斷線
//   訂閱 {"id":"…","reqType":"sub","dataType":"BTC-USDT@lastPrice"}
//   推送 {"dataType":"BTC-USDT@lastPrice","data":{"s":"BTC-USDT","c":"83235.9","E":1791912392896}}
//   每個幣約 1 筆/秒（成交才推），單條連線訂閱上限約 200，這裡每條最多 150 個
//
// REST 備援：BingX REST 對帶有瀏覽器 Origin 的請求回 403（CloudFront 擋 CORS），瀏覽器直連不通，
// 所以備援只能走同站的 /api/bingx/price（Vercel Function 代理）。為了不把成本打回去，備援只在
//   (a) 瀏覽器不支援 WebSocket／DecompressionStream，或
//   (b) 該幣訂閱後完全沒收到任何一筆價格（例如沒有成交的冷門幣）
// 時使用，而且同一個幣至少隔 REST_MIN_INTERVAL_MS 才會再打一次。
// 注意：@lastPrice 只在有成交時推送，沒有新 tick 不代表價格失效，所以快取不設過期、不會因為「太久沒更新」就去打 REST。
(function () {
  "use strict";

  const WS_URL = "wss://open-api-swap.bingx.com/swap-market";
  const REST_URL = "/api/bingx/price?symbol=";
  const REST_MIN_INTERVAL_MS = 120000;
  const REST_MIN_INTERVAL_NO_WS_MS = 15000;
  const MAX_PER_CONN = 150;
  const STALE_MS = 30000;
  const BATCH_MS = 1000;
  const JUMP_GUARD = 0.25;
  const RECONNECT_BASE_MS = 1000;
  const RECONNECT_MAX_MS = 30000;
  const DEAD_AFTER_MS = 25000;   // BingX 每 5 秒一定送 Ping；25 秒沒任何訊息就當連線半開，強制重連
  const WATCHDOG_MS = 5000;
  const JUMP_PARK_MAX_MS = 10000; // 跳價候選掛起超過這個時間就放行（冷門幣可能只有一筆 tick）
  const JUMP_PREV_MAX_AGE_MS = 60000; // 前值太舊（背景回來）時不做跳價防護

  const supported = typeof window.WebSocket === "function" && typeof window.DecompressionStream === "function";

  const prices = new Map(); // pair -> { price:Number, at:ms }
  const turnovers = new Map(); // pair -> { quoteVolume:Number, at:ms } (rolling 24h USDT)
  const wanted = new Set(); // active union of page and market board pairs
  const pageWanted = new Set();
  const marketWanted = new Set();
  const listeners = new Set();
  const pendingJump = new Map(); // pair -> { price, at }
  const restAt = new Map(); // pair -> 上次打 REST 的時間
  const unsupported = new Set(); // BingX 回「dataType not support」或 REST 回「offline」的幣（已下架合約）
  const subRequests = new Map(); // id -> { pair, kind }
  const conns = []; // { ws, pairs:Set, subscribed:Set, attempts, timer, closedByUs }
  let batch = new Map();
  let flushTimer = null;
  let nextId = 1;

  function normalizePair(value) {
    const raw = String(value || "").trim().toUpperCase().replace(/[^A-Z0-9-]/g, "");
    if (!raw) return "";
    if (raw.includes("-")) return raw;
    return raw.endsWith("USDT") ? raw.slice(0, -4) + "-USDT" : raw + "-USDT";
  }

  async function gunzip(arrayBuffer) {
    const ds = new DecompressionStream("gzip");
    const writer = ds.writable.getWriter();
    writer.write(new Uint8Array(arrayBuffer));
    writer.close();
    const ab = await new Response(ds.readable).arrayBuffer();
    return new TextDecoder().decode(ab);
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      const out = batch;
      batch = new Map();
      listeners.forEach((fn) => {
        try { fn(out); } catch (error) { /* 單一 listener 出錯不影響其他 */ }
      });
    }, BATCH_MS);
  }

  // 髒 tick 防禦：單筆與前值偏離 >25% 先掛起，下一筆落在候選價 ±10% 內才放行。
  function acceptTick(pair, rawPrice, source) {
    const price = Number(rawPrice);
    if (!Number.isFinite(price) || price <= 0) return false;
    const prev = prices.get(pair);
    const now = Date.now();
    if (prev && now - prev.at < JUMP_PREV_MAX_AGE_MS && Math.abs(price / prev.price - 1) > JUMP_GUARD) {
      const cand = pendingJump.get(pair);
      const confirmed = cand && Math.abs(price / cand.price - 1) < 0.1;
      const parkedTooLong = cand && now - cand.at > JUMP_PARK_MAX_MS;
      if (!confirmed && !parkedTooLong) {
        if (!cand) pendingJump.set(pair, { price, at: now });
        return false;
      }
    }
    pendingJump.delete(pair);
    const rec = { price, at: now, source: source || "ws" };
    prices.set(pair, rec);
    batch.set(pair, rec);
    scheduleFlush();
    return true;
  }

  function send(conn, payload) {
    if (!conn.ws || conn.ws.readyState !== WebSocket.OPEN) return false;
    try {
      conn.ws.send(typeof payload === "string" ? payload : JSON.stringify(payload));
      return true;
    } catch (error) {
      return false;
    }
  }

  function subscribePair(conn, pair) {
    if (conn.subscribed.has(pair) || unsupported.has(pair)) return;
    const id = String(nextId++);
    if (send(conn, { id, reqType: "sub", dataType: pair + "@lastPrice" })) {
      subRequests.set(id, { pair, kind: "price" });
      conn.pendingIds.add(id);
      conn.subscribed.add(pair);
      if (marketWanted.has(pair)) subscribeTicker(conn, pair);
    }
  }

  function subscribeTicker(conn, pair) {
    if (!marketWanted.has(pair) || conn.tickerSubscribed.has(pair) || unsupported.has(pair)) return;
    const id = String(nextId++);
    if (send(conn, { id, reqType: "sub", dataType: pair + "@ticker" })) {
      subRequests.set(id, { pair, kind: "ticker" });
      conn.pendingIds.add(id);
      conn.tickerSubscribed.add(pair);
    }
  }

  function unsubscribeTicker(conn, pair) {
    if (!conn.tickerSubscribed.has(pair)) return;
    send(conn, { id: String(nextId++), reqType: "unsub", dataType: pair + "@ticker" });
    conn.tickerSubscribed.delete(pair);
  }

  function markUnsupported(pair) {
    if (!pair || unsupported.has(pair)) return;
    unsupported.add(pair);
    const conn = connFor(pair);
    if (conn) {
      conn.pairs.delete(pair);
      conn.subscribed.delete(pair);
      unsubscribeTicker(conn, pair);
    }
  }

  function unsubscribePair(conn, pair) {
    if (!conn.subscribed.has(pair)) return;
    send(conn, { id: String(nextId++), reqType: "unsub", dataType: pair + "@lastPrice" });
    conn.subscribed.delete(pair);
  }

  function openConn(conn) {
    if (conn.timer) {
      clearTimeout(conn.timer);
      conn.timer = null;
    }
    if (conn.ws && (conn.ws.readyState === WebSocket.OPEN || conn.ws.readyState === WebSocket.CONNECTING)) return;
    // 舊 socket（CLOSING/CLOSED）先解除所有 handler，之後它的 onclose 才不會把新連線清掉
    detach(conn.ws);
    let ws;
    try {
      ws = new WebSocket(WS_URL);
    } catch (error) {
      scheduleReconnect(conn);
      return;
    }
    ws.binaryType = "arraybuffer";
    conn.ws = ws;
    conn.subscribed = new Set();
    conn.tickerSubscribed = new Set();
    conn.closedByUs = false;
    conn.lastMessageAt = Date.now();

    // 每個 handler 都先確認自己還是 conn 目前的 socket；孤兒 socket 的事件一律忽略
    ws.onopen = () => {
      if (conn.ws !== ws) return;
      conn.attempts = 0;
      conn.lastMessageAt = Date.now();
      conn.pairs.forEach((pair) => subscribePair(conn, pair));
    };
    ws.onmessage = async (event) => {
      if (conn.ws !== ws) return;
      conn.lastMessageAt = Date.now();
      let text;
      try {
        text = typeof event.data === "string" ? event.data : await gunzip(event.data);
      } catch (error) {
        return;
      }
      if (text === "Ping") {
        send(conn, "Pong");
        return;
      }
      let msg;
      try { msg = JSON.parse(text); } catch (error) { return; }
      if (msg && msg.id && !msg.dataType) {
        // 訂閱回覆：code 0 成功；80015 = dataType not support（合約不存在／已下架）
        const request = subRequests.get(String(msg.id));
        subRequests.delete(String(msg.id));
        conn.pendingIds.delete(String(msg.id));
        if (request && Number(msg.code) !== 0) {
          if (request.kind === "price" && Number(msg.code) === 80015) markUnsupported(request.pair);
          if (request.kind === "ticker") conn.tickerSubscribed.delete(request.pair);
        }
        return;
      }
      const data = msg && msg.data;
      if (data && data.s && msg.dataType === String(data.s).toUpperCase() + "@ticker") {
        const quoteVolume = Number(data.q);
        if (Number.isFinite(quoteVolume) && quoteVolume >= 0) {
          const pair = String(data.s).toUpperCase();
          turnovers.set(pair, { quoteVolume, at: Date.now() });
          if (prices.has(pair)) {
            batch.set(pair, prices.get(pair));
            scheduleFlush();
          }
        }
        return;
      }
      if (data && data.s && data.c != null) acceptTick(String(data.s).toUpperCase(), data.c, "ws");
    };
    ws.onclose = () => {
      if (conn.ws !== ws) return;
      conn.ws = null;
      conn.subscribed = new Set();
      conn.tickerSubscribed = new Set();
      forgetPending(conn);
      if (!conn.closedByUs && conn.pairs.size) scheduleReconnect(conn);
    };
    ws.onerror = () => {
      if (conn.ws !== ws) return;
      try { ws.close(); } catch (error) { /* onclose 會處理 */ }
    };
  }

  function forgetPending(conn) {
    conn.pendingIds.forEach((id) => subRequests.delete(id));
    conn.pendingIds = new Set();
  }

  function detach(ws) {
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      try { ws.close(); } catch (error) { /* ignore */ }
    }
  }

  // 看門狗：OPEN 卻超過 DEAD_AFTER_MS 沒收到任何訊息（含 Ping）= 半開連線，主動關掉觸發重連
  function watchdog() {
    const now = Date.now();
    conns.forEach((conn) => {
      if (!conn.ws || conn.ws.readyState !== WebSocket.OPEN) return;
      if (now - (conn.lastMessageAt || 0) > DEAD_AFTER_MS) {
        const dead = conn.ws;
        conn.ws = null;
        conn.subscribed = new Set();
        conn.tickerSubscribed = new Set();
        forgetPending(conn);
        detach(dead);
        scheduleReconnect(conn);
      }
    });
  }

  function scheduleReconnect(conn) {
    if (conn.timer) return;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, conn.attempts || 0));
    conn.attempts = (conn.attempts || 0) + 1;
    conn.timer = setTimeout(() => {
      conn.timer = null;
      openConn(conn);
    }, delay);
  }

  function closeConn(conn) {
    conn.closedByUs = true;
    if (conn.timer) {
      clearTimeout(conn.timer);
      conn.timer = null;
    }
    if (conn.ws) {
      const ws = conn.ws;
      conn.ws = null;
      detach(ws);
    }
    conn.subscribed = new Set();
    conn.tickerSubscribed = new Set();
  }

  function connFor(pair) {
    return conns.find((conn) => conn.pairs.has(pair)) || null;
  }

  function connWithRoom() {
    let conn = conns.find((item) => item.pairs.size < MAX_PER_CONN);
    if (!conn) {
      conn = { ws: null, pairs: new Set(), subscribed: new Set(), tickerSubscribed: new Set(), pendingIds: new Set(), attempts: 0, timer: null, closedByUs: false, lastMessageAt: 0 };
      conns.push(conn);
    }
    return conn;
  }

  function addPair(pair) {
    if (!supported) return;
    if (connFor(pair)) return;
    const conn = connWithRoom();
    conn.pairs.add(pair);
    if (conn.ws && conn.ws.readyState === WebSocket.OPEN) subscribePair(conn, pair);
    else openConn(conn);
  }

  function removePair(pair) {
    const conn = connFor(pair);
    if (!conn) return;
    conn.pairs.delete(pair);
    unsubscribePair(conn, pair);
    unsubscribeTicker(conn, pair);
    turnovers.delete(pair);
    if (!conn.pairs.size) {
      closeConn(conn);
      const index = conns.indexOf(conn);
      if (index >= 0) conns.splice(index, 1);
    }
  }

  // 主頁訊號與公開行情板各自維護訂閱；其中一方更新不會取消另一方的幣對。
  function syncSymbols() {
    const next = new Set([...pageWanted, ...marketWanted]);
    wanted.forEach((pair) => {
      if (!next.has(pair)) {
        wanted.delete(pair);
        removePair(pair);
      }
    });
    next.forEach((pair) => {
      if (!wanted.has(pair)) {
        wanted.add(pair);
        addPair(pair);
      }
    });
  }

  function setSymbols(list) {
    pageWanted.clear();
    (Array.isArray(list) ? list : []).map(normalizePair).filter(Boolean).forEach((pair) => pageWanted.add(pair));
    syncSymbols();
  }

  function setMarketSymbols(list) {
    const previous = new Set(marketWanted);
    marketWanted.clear();
    (Array.isArray(list) ? list : []).map(normalizePair).filter(Boolean).forEach((pair) => marketWanted.add(pair));
    previous.forEach((pair) => {
      if (marketWanted.has(pair)) return;
      const conn = connFor(pair);
      if (conn) unsubscribeTicker(conn, pair);
      turnovers.delete(pair);
    });
    syncSymbols();
    marketWanted.forEach((pair) => {
      const conn = connFor(pair);
      if (conn) subscribeTicker(conn, pair);
    });
  }

  function isUnsupported(symbol) {
    return unsupported.has(normalizePair(symbol));
  }

  function want(symbol) {
    const pair = normalizePair(symbol);
    if (!pair || pageWanted.has(pair) || unsupported.has(pair)) return;
    pageWanted.add(pair);
    syncSymbols();
  }

  function get(symbol) {
    const pair = normalizePair(symbol);
    const rec = prices.get(pair);
    return rec ? { pair, price: rec.price, at: rec.at, source: rec.source, fresh: Date.now() - rec.at < STALE_MS } : null;
  }

  async function fetchRest(pair) {
    const response = await fetch(REST_URL + encodeURIComponent(pair), { cache: "no-store" });
    const json = await response.json().catch(() => ({}));
    if (Number(json && json.code) === 109418 || /offline/i.test(String(json && json.msg || ""))) {
      markUnsupported(pair);
      throw new Error("BingX contract offline");
    }
    if (!response.ok) throw new Error("HTTP " + response.status);
    const data = json && json.data;
    const raw = Array.isArray(data)
      ? (data[0] && (data[0].price ?? data[0].lastPrice ?? data[0].close))
      : (data && (data.price ?? data.lastPrice ?? data.close)) ?? (json && json.price);
    const price = Number(String(raw ?? "").replace(/,/g, ""));
    if (!Number.isFinite(price) || price <= 0) throw new Error("BingX price missing");
    return price;
  }

  // 該幣已排進某條連線，而且連線正在建立或已開啟（首次載入時連線還在 CONNECTING，也要等）。
  function isPending(pair) {
    const conn = connFor(pair);
    return Boolean(conn && conn.ws && (conn.ws.readyState === WebSocket.CONNECTING || conn.ws.readyState === WebSocket.OPEN));
  }

  // 剛訂閱還沒收到第一筆時，先等 WebSocket 最多 waitMs，避免首次載入對 BingX REST 瞬間打幾十次。
  function waitForTick(pair, waitMs) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        off();
        clearTimeout(timer);
        resolve(value);
      };
      const off = subscribe((out) => {
        const rec = out.get(pair);
        if (rec) finish(rec.price);
      });
      const timer = setTimeout(() => finish(null), waitMs);
    });
  }

  async function restThrottled(pair, minInterval) {
    const last = restAt.get(pair) || 0;
    if (Date.now() - last < minInterval) throw new Error("BingX price not available yet");
    restAt.set(pair, Date.now());
    const value = await fetchRest(pair);
    acceptTick(pair, value, "rest");
    return value;
  }

  // 取價順序：
  //   1. 有快取就回（WebSocket 會持續更新它；沒有新成交時最後價就是現價）
  //   2. 剛訂閱還沒收到第一筆（含連線還在建立中）：等 WebSocket 最多 4 秒
  //   3. 還是沒有：走同站代理 /api/bingx/price，同一個幣每 2 分鐘最多一次
  //   4. 不支援 WebSocket 的舊瀏覽器：走代理，同一個幣每 15 秒最多一次
  async function price(symbol) {
    const pair = normalizePair(symbol);
    if (!pair) throw new Error("Invalid symbol");
    if (unsupported.has(pair)) throw new Error("BingX contract offline");
    want(pair);
    const cached = prices.get(pair);
    if (!supported) {
      if (cached && Date.now() - cached.at < STALE_MS) return cached.price;
      return restThrottled(pair, REST_MIN_INTERVAL_NO_WS_MS);
    }
    if (cached) return cached.price;
    if (isPending(pair)) {
      const live = await waitForTick(pair, 4000);
      if (live != null) return live;
    }
    return restThrottled(pair, REST_MIN_INTERVAL_MS);
  }

  function getTurnover(symbol) {
    const pair = normalizePair(symbol);
    const rec = turnovers.get(pair);
    return rec ? { ...rec, fresh: Date.now() - rec.at < 120000 } : null;
  }

  function subscribe(fn) {
    if (typeof fn === "function") listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function status() {
    return {
      supported,
      wanted: wanted.size,
      connections: conns.map((conn) => ({
        state: conn.ws ? conn.ws.readyState : -1,
        pairs: conn.pairs.size,
        subscribed: conn.subscribed.size,
        silentMs: conn.lastMessageAt ? Date.now() - conn.lastMessageAt : null
      })),
      prices: prices.size,
      unsupported: [...unsupported]
    };
  }

  if (supported) {
    setInterval(watchdog, WATCHDOG_MS);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      conns.forEach((conn) => {
        if (!conn.ws || conn.ws.readyState === WebSocket.CLOSED || conn.ws.readyState === WebSocket.CLOSING) openConn(conn);
      });
    });
    window.addEventListener("online", () => conns.forEach((conn) => openConn(conn)));
  }

  window.CatPriceFeed = {
    supported,
    setSymbols,
    setMarketSymbols,
    want,
    get,
    getTurnover,
    price,
    isUnsupported,
    subscribe,
    status,
    normalizePair,
    STALE_MS
  };
})();
