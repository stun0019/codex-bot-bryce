const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const site = path.resolve(__dirname, "../site");
const configWindow = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(site, "radar-config.js"), "utf8"), configWindow);
const config = configWindow.window.CodexRadarConfig;
const engine = require("../site/radar-engine.js");
const now = Date.now();

function market(symbol, volume = 100, patch = {}) {
  return { [symbol]: {
    ticker: { price: 100, baseVolume24h: volume, high24h: 110, low24h: 100,
      changePct: 3, at: now, fresh: true, ...patch.ticker },
    book: { bid: 99.99, ask: 100.01, timestamp: now, at: now, fresh: true, ...patch.book },
    history: patch.history || [],
    unsupported: Boolean(patch.unsupported)
  } };
}

test("liquidity proxy uses base volume times price and small universes stay visible", () => {
  const snapshots = { ...market("BTC-USDT", 100), ...market("ETH-USDT", 200) };
  const out = engine.evaluate(["BTC-USDT", "ETH-USDT"], snapshots, config, now);
  assert.equal(out.results.length, 2);
  assert.equal(out.liquidityFilterActive, false);
  assert.equal(out.results[0].metrics.estimatedNotional, 20000);
  assert.ok(out.results.every((row) => Number.isFinite(row.score) && row.score >= 0 && row.score <= 100));
});

test("bottom percentile, volatility and extreme spread filters work", () => {
  const symbols = Array.from({ length: 10 }, (_, i) => `COIN${i}-USDT`);
  const snapshots = Object.assign({}, market("BTC-USDT"), ...symbols.map((symbol, i) => market(symbol, i + 1)));
  const out = engine.evaluate(symbols, snapshots, config, now);
  assert.equal(out.results.length, 8);
  assert.equal(out.results.some((row) => row.symbol === symbols[0]), false);
  assert.equal(engine.volatilityScore(3), 100);
  assert.ok(engine.volatilityScore(20) < 100);
  assert.equal(engine.evaluate(["BTC-USDT"], market("BTC-USDT", 100,
    { ticker: { high24h: 101 } }), config, now).results.length, 0);
  assert.equal(engine.evaluate(["BTC-USDT"], market("BTC-USDT", 100,
    { book: { bid: 99, ask: 100 } }), config, now).results.length, 0);
});

test("stale book, missing BTC and missing momentum remain provisional", () => {
  const row = engine.evaluate(["ETH-USDT"], market("ETH-USDT", 100,
    { book: { timestamp: now - 20000 } }), config, now).results[0];
  assert.equal(row.metrics.spreadPct, null);
  assert.equal(row.metrics.relativeStrength, null);
  assert.equal(row.metrics.momentum1m, null);
  assert.equal(row.factors.momentum, null);
  assert.equal(row.bias, "NEUTRAL");
  assert.equal(row.provisional, true);
  for (const book of [{ bid: 0 }, { ask: 0 }, { bid: 101, ask: 100 }]) {
    const invalid = engine.evaluate(["ETH-USDT"], market("ETH-USDT", 100, { book }), config, now).results[0];
    assert.equal(invalid.metrics.spreadPct, null);
  }
  assert.equal(engine.evaluate(["ETH-USDT"], market("ETH-USDT", 100,
    { ticker: { at: now - 30000 } }), config, now).results.length, 0);
  assert.equal(engine.evaluate(["ETH-USDT"], market("ETH-USDT", 100,
    { unsupported: true }), config, now).results.length, 0);
});

test("momentum requires actual 1m and 5m samples", () => {
  const history = [
    { at: now - 300000, price: 80 },
    { at: now - 60000, price: 90 },
    { at: now, price: 100 }
  ];
  assert.ok(engine.momentumAt(history, now, 60000, 15000) > 11);
  assert.equal(engine.momentumAt(history.slice(1), now, 300000, 15000), null);
  const snapshots = { ...market("BTC-USDT"), ...market("ETH-USDT", 100, { history }) };
  const row = engine.evaluate(["BTC-USDT", "ETH-USDT"], snapshots, config, now)
    .results.find((item) => item.symbol === "ETH-USDT");
  assert.ok(row.factors.momentum > 0);
});

test("scanner subscriptions coexist with signals and reconnect", async () => {
  const sockets = [];
  const timers = [];
  class FakeSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    constructor() { this.readyState = 0; this.sent = []; sockets.push(this); }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() { this.readyState = 3; }
  }
  const context = {
    window: { WebSocket: FakeSocket, DecompressionStream: class {}, addEventListener() {} },
    document: { addEventListener() {} }, WebSocket: FakeSocket,
    setInterval() {}, setTimeout(fn) { timers.push(fn); return timers.length; }, clearTimeout() {}
  };
  vm.runInNewContext(fs.readFileSync(path.join(site, "price-feed.js"), "utf8"), context);
  const feed = context.window.CatPriceFeed;
  feed.setSymbols(["BTC-USDT"]);
  sockets[0].readyState = 1;
  sockets[0].onopen();
  feed.setScannerSymbols(["BTC-USDT", "ETH-USDT"]);
  const channels = sockets[0].sent.filter((item) => item.reqType === "sub").map((item) => item.dataType);
  for (const channel of ["BTC-USDT@lastPrice", "BTC-USDT@ticker", "BTC-USDT@bookTicker",
    "ETH-USDT@lastPrice", "ETH-USDT@ticker", "ETH-USDT@bookTicker"]) {
    assert.ok(channels.includes(channel), channel);
  }
  feed.setScannerSymbols([]);
  assert.equal(feed.status().wanted, 1);
  assert.equal(sockets[0].sent.some((item) =>
    item.reqType === "unsub" && item.dataType === "BTC-USDT@lastPrice"), false);
  feed.setScannerSymbols(["BTC-USDT"]);
  sockets[0].onmessage({ data: JSON.stringify({ dataType: "BTC-USDT@ticker",
    data: { s: "BTC-USDT", c: "100", v: "5", h: "110", l: "100", p: "2" } }) });
  sockets[0].onmessage({ data: JSON.stringify({ dataType: "BTC-USDT@bookTicker",
    data: { s: "BTC-USDT", b: "99", a: "101", T: Date.now() } }) });
  await Promise.resolve();
  assert.equal(feed.getTicker("BTC-USDT").baseVolume24h, 5);
  assert.equal(feed.getBookTicker("BTC-USDT").fresh, true);
  sockets[0].readyState = 3;
  sockets[0].onclose();
  timers[0]();
  sockets[1].readyState = 1;
  sockets[1].onopen();
  assert.ok(sockets[1].sent.some((item) => item.dataType === "BTC-USDT@bookTicker"));
});
