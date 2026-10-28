(function () {
  "use strict";

  const feed = window.CatPriceFeed;
  const cards = document.getElementById("marketCards");
  const connection = document.getElementById("marketConnection");
  const form = document.getElementById("marketAddForm");
  const input = document.getElementById("marketSymbol");
  const message = document.getElementById("marketFormMessage");
  if (!feed || !cards || !connection || !form || !input || !message) return;

  const STORAGE_KEY = "codex-bot-market-symbols-v1";
  const DEFAULT_SYMBOLS = ["BTC-USDT", "ETH-USDT", "SOL-USDT"];
  const MAX_SYMBOLS = 12;
  const formatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 12 });

  function validSymbol(raw) {
    const symbol = String(raw || "").trim().toUpperCase();
    if (/^[A-Z0-9]{2,15}$/.test(symbol)) return symbol + "-USDT";
    return /^[A-Z0-9]{2,15}-USDT$/.test(symbol) ? symbol : "";
  }

  function readSymbols() {
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (Array.isArray(value) && value.length) {
        const saved = [...new Set(value.map(validSymbol).filter(Boolean))].slice(0, MAX_SYMBOLS);
        if (saved.length) return saved;
      }
    } catch (error) { /* Private mode may block storage. */ }
    return [...DEFAULT_SYMBOLS];
  }

  let symbols = readSymbols();

  function saveSymbols() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(symbols)); } catch (error) { /* Storage is optional. */ }
    feed.setMarketSymbols(symbols);
  }

  function connectionState() {
    if (!feed.supported) return ["瀏覽器不支援即時行情", "error"];
    if (navigator.onLine === false) return ["網路已斷線", "error"];
    const states = feed.status().connections.map((item) => item.state);
    if (states.includes(WebSocket.OPEN)) return ["即時連線", "live"];
    if (states.includes(WebSocket.CONNECTING)) return ["連線中", "pending"];
    return ["連線中斷，重試中", "error"];
  }

  function render() {
    const [label, state] = connectionState();
    connection.textContent = label;
    connection.dataset.state = state;
    cards.replaceChildren();
    for (const symbol of symbols) {
      const card = document.createElement("article");
      card.className = "market-card";
      const top = document.createElement("div");
      top.className = "market-card-top";
      const name = document.createElement("span");
      name.className = "market-card-symbol";
      name.textContent = symbol;
      const remove = document.createElement("button");
      remove.className = "market-card-remove";
      remove.type = "button";
      remove.setAttribute("aria-label", "移除 " + symbol);
      remove.textContent = "×";
      remove.addEventListener("click", () => {
        symbols = symbols.filter((item) => item !== symbol);
        saveSymbols();
        render();
      });
      top.append(name, remove);
      const price = document.createElement("strong");
      price.className = "market-card-price";
      const time = document.createElement("span");
      time.className = "market-card-time";
      const quote = feed.get(symbol);
      const unavailable = feed.isUnsupported(symbol);
      if (quote) {
        price.textContent = formatter.format(quote.price) + " USDT";
        time.textContent = (quote.fresh && state === "live" ? "更新 " : "最後報價 ") +
          new Date(quote.at).toLocaleTimeString("zh-TW", { hour12: false });
        card.dataset.stale = String(!quote.fresh || state !== "live");
      } else {
        price.textContent = "—";
        time.textContent = unavailable ? "合約不可用" : state === "error" ? "無法取得報價" : "等待報價";
        card.dataset.stale = "true";
      }
      card.append(top, price, time);
      cards.append(card);
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const symbol = validSymbol(input.value);
    if (!symbol) { message.textContent = "請輸入 USDT 永續合約代碼，例如 BTC-USDT"; return; }
    if (symbols.includes(symbol)) { message.textContent = "已在清單中"; return; }
    if (symbols.length >= MAX_SYMBOLS) { message.textContent = "最多追蹤 12 個合約"; return; }
    symbols.push(symbol);
    input.value = "";
    message.textContent = "";
    saveSymbols();
    render();
  });

  feed.setMarketSymbols(symbols);
  feed.subscribe(render);
  window.addEventListener("online", render);
  window.addEventListener("offline", render);
  setInterval(render, 5000);
  render();
})();
