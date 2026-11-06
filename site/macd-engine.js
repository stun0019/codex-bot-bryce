(function (root) {
  'use strict';
  const Engine = root.StrategyEngine || (typeof require === 'function' ? require('./strategy-engine.js') : null);
  const VERSION = 'sma83-ema200-dual-watch-v1';
  const PROFILES = Object.freeze({
    '4h15m': Object.freeze({ id: '4h15m', label: '4H＋15M', high: '4h', low: '15m' }),
    '1h5m': Object.freeze({ id: '1h5m', label: '1H＋5M', high: '1h', low: '5m' })
  });
  const clone = value => JSON.parse(JSON.stringify(value));

  function trend(bars) {
    if (bars.length < 200) return null;
    const closes = bars.slice(-499).map(bar => bar.close);
    if (!closes.every(value => Number.isFinite(value) && value > 0)) throw Error('均線收盤價無效');
    const sma83 = closes.slice(-83).reduce((sum, value) => sum + value, 0) / 83;
    let ema200 = closes.slice(0, 200).reduce((sum, value) => sum + value, 0) / 200;
    for (let i = 200; i < closes.length; i++) ema200 += (closes[i] - ema200) * 2 / 201;
    // Price position and lower-timeframe indicators do not change the direction.
    return {
      sma83, ema200, close: closes.at(-1),
      direction: sma83 > ema200 ? 'LONG' : sma83 < ema200 ? 'SHORT' : null,
      at: bars.at(-1).closeTime + 1
    };
  }

  function check(bar, previous, duration) {
    if (!bar || ![bar.openTime, bar.closeTime, bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite) ||
        bar.openTime % duration || bar.closeTime !== bar.openTime + duration - 1 ||
        bar.low <= 0 || bar.volume < 0 || bar.low > Math.min(bar.open, bar.close) ||
        bar.high < Math.max(bar.open, bar.close) || bar.high < bar.low ||
        (previous && bar.openTime !== previous.openTime + duration)) throw Error('K 線不連續或格式錯誤');
  }

  function pivots(bars) {
    if (bars.length < 5) return [];
    const bar = bars.at(-3), neighbors = [bars.at(-5), bars.at(-4), bars.at(-2), bars.at(-1)];
    const point = (side, price) => ({ side, price, bar: clone(bar), openTime: bar.openTime,
      confirmedAt: bars.at(-1).closeTime + 1 });
    const result = [];
    if (neighbors.every(b => b.high < bar.high)) result.push(point('HIGH', bar.high));
    if (neighbors.every(b => b.low > bar.low)) result.push(point('LOW', bar.low));
    return result;
  }

  function structure(highs, lows, direction) {
    const high = highs.at(-1), previousHigh = highs.at(-2), low = lows.at(-1), previousLow = lows.at(-2);
    let state = 'INSUFFICIENT', highChange = null, lowChange = null;
    if (high && previousHigh && low && previousLow) {
      highChange = high.price > previousHigh.price ? 'HH' : high.price < previousHigh.price ? 'LH' : 'EQ';
      lowChange = low.price > previousLow.price ? 'HL' : low.price < previousLow.price ? 'LL' : 'EQ';
      state = highChange === 'HH' && lowChange === 'HL' ? 'RISING' :
        highChange === 'LH' && lowChange === 'LL' ? 'FALLING' : 'MIXED';
    }
    return {
      state, highChange, lowChange,
      previousHigh: previousHigh ? clone(previousHigh) : null,
      previousLow: previousLow ? clone(previousLow) : null,
      aligned: state === 'RISING' ? direction === 'LONG' : state === 'FALLING' ? direction === 'SHORT' : null
    };
  }

  function createAnalyzer(id = '4h15m') {
    const profile = PROFILES[id];
    if (!profile) throw Error('未知週期');
    const higher = [], lower = [], highs = [], lows = [];
    let bias = null;
    function pushHigh(bar) {
      check(bar, higher.at(-1), Engine.INTERVALS[profile.high]);
      higher.push(clone(bar));
      if (higher.length > 499) higher.shift();
      bias = trend(higher);
    }
    function pushLow(bar) {
      check(bar, lower.at(-1), Engine.INTERVALS[profile.low]);
      if (bias && bias.at > bar.closeTime + 1) throw Error('大框架資料晚於小框架');
      lower.push(clone(bar));
      if (lower.length > 499) lower.shift();
      for (const point of pivots(lower)) {
        const points = point.side === 'HIGH' ? highs : lows;
        points.push(point);
        if (points.length > 2) points.shift();
      }
      for (const points of [highs, lows]) {
        while (points.length && points[0].openTime < lower[0].openTime) points.shift();
      }
      const direction = bias?.direction || null;
      return {
        candidate: null, pending: null,
        status: direction ? 'WATCH' : bias ? 'NO_DIRECTION' : 'INSUFFICIENT',
        reason: direction ? '大框架均線方向候選，進場由你自行判斷' :
          bias ? 'SMA83與EMA200相等，觀望' : '大框架不足200根已收盤K線',
        trend: bias ? clone(bias) : null, direction,
        recentHigh: highs.length ? clone(highs.at(-1)) : null,
        recentLow: lows.length ? clone(lows.at(-1)) : null,
        structure: structure(highs, lows, direction),
        lastClose: bar.close, confirmedAt: bar.closeTime + 1, entryFilter: { enabled: false }
      };
    }
    return { pushHigh, pushLow };
  }

  function analyze(market, higher, lower, asOf, capital = 200, id = '4h15m') {
    const profile = PROFILES[id];
    if (!profile) throw Error('未知週期');
    if (!Number.isFinite(asOf)) throw Error('掃描時間無效');
    for (const [bars, duration] of [[higher, Engine.INTERVALS[profile.high]], [lower, Engine.INTERVALS[profile.low]]]) {
      if (!Array.isArray(bars) || !bars.length || bars.at(-1).closeTime !== Math.floor(asOf / duration) * duration - 1)
        throw Error('需要最新已收盤K線');
    }
    const analyzer = createAnalyzer(id);
    let cursor = 0, result = { candidate: null, pending: null, direction: null, status: 'INSUFFICIENT' };
    for (const bar of lower) {
      // Only feed higher candles that were already closed at this lower candle.
      while (cursor < higher.length && higher[cursor].closeTime <= bar.closeTime) analyzer.pushHigh(higher[cursor++]);
      result = analyzer.pushLow(bar);
    }
    return result;
  }

  const api = { MODE: 'CANDIDATES_ONLY', VERSION, PROFILES, trend, structure, createAnalyzer, analyze,
    valid: () => false, isVersion: version => version === VERSION };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  // Keep this integration name so existing stored positions retain their tracking safeguards.
  root.MacdStrategy = api;
})(typeof window !== 'undefined' ? window : globalThis);
