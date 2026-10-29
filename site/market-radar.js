(function () {
  "use strict";

  const feed = window.CatPriceFeed;
  const engine = window.CodexRadarEngine;
  const config = window.CodexRadarConfig;
  const list = document.getElementById("radarList");
  const status = document.getElementById("radarStatus");
  const progress = document.getElementById("radarProgress");
  if (!feed || !engine || !config || !list || !status || !progress) return;

  const history = new Map();
  let previousOrder = [];
  const decimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
  const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });
  const priceFormat = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 9 });
  const spreadFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });
  const factorNames = {
    liquidity: "流動性",
    spread: "價差品質",
    volatility: "波動性",
    relativeStrength: "相對強弱",
    momentum: "短線動能"
  };
  const biasNames = { "LONG BIAS": "偏多", "SHORT BIAS": "偏空", NEUTRAL: "中性" };
  const confidenceNames = { HIGH: "高", MEDIUM: "中", LOW: "低" };

  function formatNumber(value, suffix = "") {
    return typeof value === "number" && Number.isFinite(value) ? decimal.format(value) + suffix : "—";
  }

  function formatSpread(value) {
    return typeof value === "number" && Number.isFinite(value)
      ? spreadFormat.format(value) + "%" : "—";
  }

  function element(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value != null) node.textContent = value;
    return node;
  }

  function metric(label, value) {
    const cell = element("div", "radar-metric");
    cell.append(element("span", "", label), element("strong", "", value));
    return cell;
  }

  function renderCard(row) {
    const card = element("article", "radar-card");
    card.dataset.bias = row.bias;
    const header = element("div", "radar-card-head");
    const identity = element("div", "radar-identity");
    identity.append(element("span", "radar-rank", "#" + row.rank),
      element("strong", "radar-symbol", row.symbol));
    const badges = element("div", "radar-badges");
    badges.append(element("span", "radar-score-label", "機會分數"),
      element("strong", "radar-score", formatNumber(row.score)),
      element("span", "radar-bias", biasNames[row.bias] || "中性"),
      element("span", "radar-confidence", "信心：" + (confidenceNames[row.confidence] || "低")));
    if (row.provisional) badges.append(element("span", "radar-provisional", "資料累積中"));
    header.append(identity, badges);

    const metrics = element("div", "radar-metrics");
    const m = row.metrics;
    metrics.append(
      metric("現價", priceFormat.format(m.price)),
      metric("24小時漲跌", formatNumber(m.changePct, "%")),
      metric("估算成交規模", "≈ $" + compact.format(m.estimatedNotional)),
      metric("24小時振幅", formatNumber(m.rangePct, "%")),
      metric("買賣價差", formatSpread(m.spreadPct)),
      metric("相對 BTC 強弱", formatNumber(m.relativeStrength, "%")),
      metric("1分鐘動能", formatNumber(m.momentum1m, "%")),
      metric("5分鐘動能", formatNumber(m.momentum5m, "%"))
    );
    const factors = element("div", "radar-factors");
    Object.entries(factorNames).forEach(([key, label]) => {
      const value = row.factors[key];
      factors.append(metric(label, value == null ? "累積中" : formatNumber(value)));
    });
    card.append(header, metrics, factors);
    return card;
  }

  feed.subscribe((batch) => {
    const now = Date.now();
    for (const [symbol, record] of batch) {
      if (!config.universe.includes(symbol) || record.source !== "ws" ||
          !Number.isFinite(record.price) || record.price <= 0) continue;
      const samples = history.get(symbol) || [];
      if (!samples.length || samples[samples.length - 1].at < record.at) {
        samples.push({ at: record.at, price: record.price });
      }
      while (samples.length && samples[0].at < now - config.historyMaxMs) samples.shift();
      history.set(symbol, samples);
    }
  });

  function render() {
    const now = Date.now();
    const snapshots = {};
    for (const symbol of config.universe) {
      snapshots[symbol] = {
        ticker: feed.getTicker(symbol),
        book: feed.getBookTicker(symbol),
        history: history.get(symbol) || [],
        unsupported: feed.isUnsupported(symbol)
      };
    }
    const outcome = engine.evaluate(config.universe, snapshots, config, now, previousOrder);
    previousOrder = outcome.results.map((row) => row.symbol);
    const state = feed.status();
    const connected = state.connections.some((conn) => conn.state === WebSocket.OPEN);
    status.textContent = !feed.supported ? "瀏覽器不支援 WebSocket / GZIP" :
      navigator.onLine === false ? "網路已斷線" :
      connected ? "即時掃描中" : "連線中／重試中";
    status.dataset.state = connected ? "live" : "pending";
    progress.textContent = "候選 " + config.universe.length + " · 有效 " +
      outcome.validMarkets + " · 排除 " + outcome.filtered +
      " · 資料累積中 " + outcome.warming +
      (outcome.liquidityFilterActive ? " · 已啟用相對流動性篩選" : " · 流動性篩選暖機中") +
      (outcome.btcReady ? "" : " · BTC 基準累積中");

    list.replaceChildren();
    const top = outcome.results.slice(0, config.topCount);
    if (!top.length) {
      list.append(element("p", "radar-empty",
        outcome.warming ? "資料累積中：等待有效的 ticker 與買賣報價。" :
          "目前沒有通過篩選的市場。"));
      return;
    }
    top.forEach((row) => list.append(renderCard(row)));
  }

  feed.setScannerSymbols(config.universe);
  render();
  setInterval(render, config.scoreIntervalMs);
})();
