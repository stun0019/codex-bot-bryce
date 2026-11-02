const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const site = path.resolve(__dirname, '../site');
const code = fs.readFileSync(path.join(site, 'price-feed.js'), 'utf8');

function harness(options = {}) {
  let now = 1800000000000, id = 0;
  const sockets = [], calls = [], timers = new Map(), intervals = [];
  const symbols = ['BTCUSDT', 'ETHUSDT', '1000PEPEUSDT', 'EOSUSDT'].map(symbol => ({
    symbol, quoteAsset: 'USDT', contractType: 'PERPETUAL', status: symbol === 'EOSUSDT' ? 'SETTLING' : 'TRADING'
  }));
  class FakeSocket {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(text) { this.sent.push(JSON.parse(text)); }
    close() { this.readyState = 3; }
    open() { this.readyState = 1; this.onopen(); }
    emit(data) { this.onmessage({ data: JSON.stringify(data) }); }
  }
  class Clock extends Date { static now() { return now; } }
  const context = {
    window: { WebSocket: options.noWS ? undefined : FakeSocket, addEventListener() {} },
    document: { visibilityState: 'visible', addEventListener() {} },
    WebSocket: FakeSocket, Date: Clock, AbortController, console,
    setTimeout(fn, ms) { timers.set(++id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); }, setInterval(fn) { intervals.push(fn); },
    async fetch(url, init) {
      calls.push(url);
      if (options.fetch) return options.fetch(url, init, now, symbols);
      return { ok: true, async json() {
        if (url.endsWith('/exchangeInfo')) return { symbols };
        return { symbol: new URL(url).searchParams.get('symbol'), price: '100', time: now };
      } };
    }
  };
  vm.runInNewContext(code, context);
  const feed = context.window.CatPriceFeed;
  async function drain() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
  async function advance(ms = 0) {
    now += ms;
    for (let i = 0; i < 30; i++) {
      const due = [...timers].filter(([,t]) => t.at <= now);
      if (!due.length) { await drain(); if (![...timers.values()].some(t => t.at <= now)) break; continue; }
      for (const [key, timer] of due) { timers.delete(key); timer.fn(); }
      await drain();
    }
  }
  async function start(list = ['BTC-USDT']) {
    feed.setSymbols(list);
    await advance();
    sockets.filter(s => s.readyState === 0).forEach(s => s.open());
    await advance(300);
  }
  function emit(route, data) { sockets.findLast(s => s.url.includes('/' + route + '/') && s.readyState === 1).emit(data); }
  return { feed, sockets, calls, intervals, advance, start, emit, get now() { return now; } };
}

test('normalizes original and Binance symbol forms without changing stored order keys', () => {
  const { feed } = harness();
  for (const value of ['BTC', 'btcusdt', 'BTC-USDT', 'btc/usdt', 'BTC_USDT']) assert.equal(feed.normalizePair(value), 'BTC-USDT');
  for (const value of ['', '-USDT', '<BTC>']) assert.equal(feed.normalizePair(value), '');
});

test('routes market and book streams separately and batches control traffic', async () => {
  const h = harness();
  h.feed.setSymbols(['BTC-USDT']);
  h.feed.setScannerSymbols(['BTC-USDT', 'ETH-USDT']);
  await h.advance();
  h.sockets.forEach(s => s.open()); await h.advance(300);
  assert.equal(h.sockets.length, 2);
  const market = h.sockets.find(s => s.url.includes('/market/'));
  const book = h.sockets.find(s => s.url.includes('/public/'));
  assert.deepEqual([...market.sent[0].params].sort(), ['btcusdt@aggTrade','btcusdt@ticker','ethusdt@aggTrade','ethusdt@ticker']);
  assert.deepEqual([...book.sent[0].params].sort(), ['btcusdt@bookTicker','ethusdt@bookTicker']);
  assert.equal(market.sent.length, 1);
  h.feed.setScannerSymbols([]); await h.advance(300); await h.advance(300);
  assert.equal(h.feed.status().wanted, 1);
  assert.ok(market.sent.some(m => m.method === 'UNSUBSCRIBE' && m.params.includes('ethusdt@aggTrade')));
  assert.equal(market.sent.some(m => m.method === 'UNSUBSCRIBE' && m.params.includes('btcusdt@aggTrade')), false);
  assert.equal(book.readyState, 3);
});

test('parses combined/raw trades, tickers and exchange-timestamped books', async () => {
  const h = harness(); h.feed.setScannerSymbols(['BTC-USDT']); await h.start();
  h.emit('market', { stream: 'btcusdt@aggTrade', data: { e: 'aggTrade', s: 'BTCUSDT', p: '100', E: h.now, st: 1 } });
  h.emit('market', { e: '24hrTicker', s: 'BTCUSDT', c: '101', v: '5', h: '110', l: '90', P: '2.5', E: h.now });
  h.emit('public', { e: 'bookTicker', s: 'BTCUSDT', b: '100', a: '102', T: h.now, E: h.now });
  assert.equal(h.feed.get('BTC').price, 101);
  assert.equal(h.feed.getTicker('BTC').baseVolume24h, 5);
  assert.equal(h.feed.getTicker('BTC').changePct, 2.5);
  assert.equal(h.feed.getBookTicker('BTC').fresh, true);
  const batches = []; h.feed.subscribe(batch => batches.push(batch)); await h.advance(1000);
  assert.equal(batches[0].get('BTC-USDT').price, 101);
});

test('converts 1000-token price and volume into original single-token units', async () => {
  const h = harness(); h.feed.setScannerSymbols(['PEPE-USDT', '1000PEPE-USDT']); await h.start(['PEPE-USDT']);
  h.emit('market', { e: '24hrTicker', s: '1000PEPEUSDT', c: '0.01', h: '0.011', l: '0.009', v: '20', P: '5', E: h.now });
  h.emit('public', { e: 'bookTicker', s: '1000PEPEUSDT', b: '0.0099', a: '0.0101', T: h.now });
  assert.equal(h.feed.get('PEPE').price, 0.00001);
  assert.equal(h.feed.getTicker('PEPE').baseVolume24h, 20000);
  assert.equal(h.feed.getTicker('PEPE').high24h, 0.000011);
  assert.equal(h.feed.getBookTicker('PEPE').bid, 0.0099 / 1000);
  assert.equal(h.feed.get('1000PEPE').price, 0.01);
  assert.equal(h.feed.getTicker('1000PEPE').baseVolume24h, 20);
  assert.equal(h.sockets[0].sent[0].params.filter(p => p.endsWith('@aggTrade')).length, 1);
});

test('filters missing and non-trading contracts instead of returning another instrument', async () => {
  const h = harness(); await h.start(['BTC', 'EOS', 'MKR']);
  assert.equal(h.feed.isUnsupported('EOS'), true);
  assert.equal(h.feed.isUnsupported('MKR'), true);
  await assert.rejects(h.feed.price('MKR'), /unavailable/);
  assert.equal(h.calls.some(url => url.includes('ticker/price')), false);
  assert.deepEqual([...h.sockets[0].sent[0].params], ['btcusdt@aggTrade']);
});

test('REST fallback coalesces requests, scales aliases and uses Binance exclusively', async () => {
  const h = harness({ noWS: true });
  const [a,b] = await Promise.all([h.feed.price('PEPE'), h.feed.price('PEPE-USDT')]);
  assert.equal(a, 0.1); assert.equal(b, a);
  assert.equal(h.calls.filter(url => url.includes('ticker/price')).length, 1);
  assert.ok(h.calls.every(url => url.startsWith('https://fapi.binance.com/')));
  assert.ok(h.calls.some(url => url.endsWith('symbol=1000PEPEUSDT')));
});

test('rejects malformed, stale, future, out-of-order and COIN-M data', async () => {
  const h = harness(); await h.start();
  const emit = (patch) => h.emit('market', { e: 'aggTrade', s: 'BTCUSDT', p: '100', E: h.now, ...patch });
  emit({});
  for (const patch of [{p:'NaN'}, {p:'-1'}, {p:'0'}, {E:h.now-31000,p:'90'}, {E:h.now+31000,p:'90'}, {E:h.now-1,p:'90'}, {st:2,p:'90'}]) emit(patch);
  assert.equal(h.feed.get('BTC').price, 100);
  await h.advance(31000); assert.equal(h.feed.get('BTC').fresh, false);
  assert.equal(await h.feed.price('BTC'), 100);
  assert.equal(h.feed.get('BTC').source, 'rest');
});

test('quiet sockets use subscription probes and reconnect only when probe fails', async () => {
  const h = harness(); await h.start();
  await h.advance(31000); h.intervals[0]();
  const first = h.sockets[0];
  assert.equal(first.sent.at(-1).method, 'LIST_SUBSCRIPTIONS');
  first.emit({ id: first.sent.at(-1).id, result: ['btcusdt@aggTrade'] });
  await h.advance(16000); h.intervals[0](); assert.equal(first.readyState, 1);
  await h.advance(16000); h.intervals[0]();
  await h.advance(16000); h.intervals[0](); assert.equal(first.readyState, 3);
  await h.advance(1000); const next = h.sockets.at(-1); next.open(); await h.advance(300);
  assert.ok(next.sent[0].params.includes('btcusdt@aggTrade'));
});

test('closed/orphan sockets cannot overwrite data and subscriptions recover after a disconnect', async () => {
  const h = harness(); h.feed.setScannerSymbols(['BTC']); await h.start();
  const first = h.sockets[0], oldHandler = first.onmessage;
  first.readyState = 3; first.onclose(); await h.advance(1000);
  const next = h.sockets.at(-1); next.open(); await h.advance(300);
  assert.ok(next.sent[0].params.includes('btcusdt@ticker'));
  oldHandler({ data: JSON.stringify({e:'aggTrade',s:'BTCUSDT',p:'999',E:h.now}) });
  assert.equal(h.feed.get('BTC'), null);
  next.emit({e:'aggTrade',s:'BTCUSDT',p:'100',E:h.now});
  assert.equal(h.feed.get('BTC').price, 100);
});

test('failed catalog fetch retries and never mislabels all contracts as unsupported', async () => {
  let attempts = 0;
  const h = harness({ fetch: async (url, init, now, symbols) => {
    if (++attempts === 1) throw new Error('network failure');
    return { ok: true, json: async () => ({ symbols }) };
  } });
  await h.start(); assert.equal(h.sockets.length, 0);
  assert.equal(h.feed.isUnsupported('BTC'), false);
  assert.match(h.feed.status().lastError, /network failure/);
  await h.advance(60000); h.intervals[0](); await h.advance();
  assert.equal(h.sockets.length, 1);
});

test('jump guard requires confirmation before a large price move is delivered', async () => {
  const h = harness(); await h.start();
  const emit = p => h.emit('market', { e:'aggTrade', s:'BTCUSDT', p, E:h.now });
  emit('100'); emit('150'); assert.equal(h.feed.get('BTC').price, 100);
  emit('151'); assert.equal(h.feed.get('BTC').price, 151);
});

test('stale REST prices are rejected and repeated failures are throttled', async () => {
  const h = harness({ noWS: true, fetch: async (url, init, now, symbols) => ({ok:true,
    json: async () => url.endsWith('exchangeInfo') ? {symbols} : {price:'100',time:now-60000}}) });
  await assert.rejects(h.feed.price('BTC'), /stale/);
  await assert.rejects(h.feed.price('BTC'), /temporarily/);
  assert.equal(h.feed.get('BTC'), null);
});

test('removing an owner preserves other owners, but clears removed prices', async () => {
  const h = harness(); h.feed.setMarketSymbols(['BTC']); await h.start();
  h.emit('market',{e:'aggTrade',s:'BTCUSDT',p:'100',E:h.now});
  h.feed.setSymbols([]); await h.advance(); assert.equal(h.feed.get('BTC').price, 100);
  h.feed.setMarketSymbols([]); await h.advance(); assert.equal(h.feed.get('BTC'), null);
  assert.equal(h.sockets[0].readyState, 3);
});
