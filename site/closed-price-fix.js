(function () {
  const gridId = "signalGrid";
  let orderMap = new Map();
  let orderById = new Map();
  let loading = false;

  function text(value) {
    return String(value == null ? "" : value).trim();
  }

  function compact(value) {
    return text(value).replace(/\s+/g, "");
  }

  function cleanSymbol(value) {
    const raw = text(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
    return raw.endsWith("USDT") ? raw : raw + "USDT";
  }

  function orderKey(symbol, time) {
    return `${cleanSymbol(symbol)}|${compact(time)}`;
  }

  function isClosedOrder(order) {
    const label = text(order.reachedLabel).toUpperCase();
    const status = text(order.status).toUpperCase();
    const finalType = text(order.finalType);
    return Boolean(order.resultLocked)
      || label === "SL"
      || label === "FTP"
      || finalType === "loss"
      || text(order.status).includes("止損")
      || status.includes("FTP");
  }

  function finalPrice(order) {
    const label = text(order.reachedLabel).toUpperCase();
    const direct = text(order.reachedPrice);
    if (direct) return direct;
    if (label === "SL") return text(order.sl);
    if (label === "TP1") return text(order.tp1);
    if (label === "TP2") return text(order.tp2);
    if (label === "TP3") return text(order.tp3);
    if (label === "FTP") return text(order.ftp);
    return "";
  }

  function readCardSymbol(card) {
    const symbolEl = card.querySelector(".symbol");
    if (symbolEl) return cleanSymbol(symbolEl.textContent);
    const copyButton = card.querySelector(".symbol-copy-button");
    if (copyButton) return cleanSymbol(copyButton.closest(".symbol-row")?.textContent || "");
    return "";
  }

  function readCardTime(card) {
    const timeEl = card.querySelector(".time");
    const match = text(timeEl && timeEl.textContent).match(/\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}/);
    return match ? match[0] : "";
  }

  // 卡片的訂單 id：article[data-order-id] → .like-button[data-signal-id]（主程式契約）。
  function readCardOrderId(card) {
    const own = card.dataset && card.dataset.orderId;
    if (own) return String(own);
    const nested = card.querySelector("[data-order-id], [data-signal-id]");
    if (!nested) return "";
    return String(nested.dataset.orderId || nested.dataset.signalId || "");
  }

  // 先用 id 對應，找不到才退回 symbol|time。
  function findOrderForCard(card) {
    const id = readCardOrderId(card);
    if (id && orderById.has(id)) return orderById.get(id);
    return orderMap.get(orderKey(readCardSymbol(card), readCardTime(card)));
  }

  function applyClosedPrices() {
    const grid = document.getElementById(gridId);
    if (!grid || (!orderMap.size && !orderById.size)) return;
    grid.querySelectorAll(".signal-card").forEach((card) => {
      const order = findOrderForCard(card);
      if (!order || !isClosedOrder(order)) return;

      const price = finalPrice(order);
      const box = card.querySelector(".price-box.bingx-price");
      const value = box && box.querySelector("strong");
      const time = box && box.querySelector(".box-label b");
      if (!price || !box || !value) return;

      value.textContent = price;
      if (time) time.textContent = "";
      // 已結案訂單不再取即時價，主程式會把格子標成 offline；這裡維持原本的綠底樣式。
      box.classList.remove("offline");
      box.classList.add("online");
      box.classList.add("closed-final-price");
      box.dataset.closedFinalPrice = "1";
    });
  }

  async function loadOrders() {
    if (loading || window.CatMaintenance) return;
    loading = true;
    try {
      const response = await fetch("/api/orders", { cache: "no-store" });
      if (!response.ok) throw new Error("orders " + response.status);
      const orders = await response.json();
      const nextMap = new Map();
      const nextById = new Map();
      if (Array.isArray(orders)) {
        orders.forEach((order) => {
          nextMap.set(orderKey(order.symbol, order.time), order);
          if (order && order.id) nextById.set(String(order.id), order);
        });
      }
      orderMap = nextMap;
      orderById = nextById;
      applyClosedPrices();
    } catch (error) {
      // Keep the last successful map so the UI does not flicker during a temporary API miss.
      console.warn("closed-price-fix: orders load failed", error);
    } finally {
      loading = false;
    }
  }

  function bind() {
    const grid = document.getElementById(gridId);
    if (!grid || grid.dataset.closedPriceFix === "1") return;
    grid.dataset.closedPriceFix = "1";

    const observer = new MutationObserver(() => {
      requestAnimationFrame(applyClosedPrices);
    });
    observer.observe(grid, { childList: true, subtree: true, characterData: true });

    loadOrders();
    setInterval(loadOrders, 15000);
    setInterval(applyClosedPrices, 1000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bind);
  } else {
    bind();
  }
})();
