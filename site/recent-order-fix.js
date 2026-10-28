(function () {
  const listId = "broadcastHistoryList";
  const buttonId = "broadcastMenuButton";
  const menuWrapSelector = ".broadcast-menu-wrap";
  const maxItems = 120;

  function text(value) {
    return String(value == null ? "" : value).trim();
  }

  function escapeHtml(value) {
    return text(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function cleanSymbol(symbol) {
    return text(symbol).replace(/USDT$/i, "");
  }

  function yearFor(order) {
    const created = Date.parse(order.createdAt || order.updatedAt || "");
    if (Number.isFinite(created)) return new Date(created).getFullYear();
    return new Date().getFullYear();
  }

  function parseOrderTime(order) {
    const raw = text(order.time);
    const match = raw.match(/^(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
    if (!match) {
      const created = Date.parse(order.createdAt || "");
      return Number.isFinite(created) ? created : 0;
    }
    const [, month, day, hour, minute] = match;
    return Date.parse(
      `${yearFor(order)}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T${hour.padStart(2, "0")}:${minute}:00+08:00`
    ) || 0;
  }

  function signalKey(order) {
    return order.id || `${order.symbol || ""}-${order.time || ""}-${order.entry || order.trigger || ""}`;
  }

  function reachedLabel(order) {
    const label = text(order.reachedLabel).toUpperCase();
    const status = text(order.status).toUpperCase();
    if (["TP1", "TP2", "TP3", "FTP", "SL"].includes(label)) return label;
    if (status.includes("FTP")) return "FTP";
    if (status.includes("TP3")) return "TP3";
    if (status.includes("TP2")) return "TP2";
    if (status.includes("TP1")) return "TP1";
    if (text(order.status).includes("止損") || text(order.finalType) === "loss") return "SL";
    return "";
  }

  function reachedDesc(order) {
    const label = reachedLabel(order);
    if (label === "SL") return "觸發止損";
    if (label === "FTP") return "觸發FTP";
    if (label) return `觸發${label}`;
    return "";
  }

  function eventTime(base, step) {
    return base + step;
  }

  function buildEvents(orders) {
    const events = [];
    orders
      .filter((order) => text(order.symbol))
      .forEach((order, index) => {
        const base = parseOrderTime(order);
        const key = signalKey(order);
        const symbol = cleanSymbol(order.symbol || "訊號");
        const sequence = index * 10;

        events.push({
          key: `${key}:entry`,
          symbol,
          desc: "進場訊號",
          isLoss: false,
          at: eventTime(base, 0),
          order: sequence
        });

        const desc = reachedDesc(order);
        const label = reachedLabel(order);
        if (desc) {
          events.push({
            key: `${key}:${label}`,
            symbol,
            desc,
            isLoss: label === "SL" || text(order.finalType) === "loss",
            at: eventTime(base, 1),
            order: sequence + 1
          });
        }

        if (order.hedged) {
          events.push({
            key: `${key}:hedge:${order.hedgeEventAt || "set"}`,
            symbol,
            desc: "套保通知",
            isLoss: false,
            at: eventTime(base, 2),
            order: sequence + 2
          });
        }

        const ftpPrice = text(order.ftpNotifyPrice || "");
        if (ftpPrice || text(order.ftpEventAt)) {
          events.push({
            key: `${key}:ftp-change:${order.ftpEventAt || ftpPrice}`,
            symbol,
            desc: `FTP變更通知${ftpPrice ? " " + ftpPrice : ""}`,
            isLoss: false,
            at: eventTime(base, 3),
            order: sequence + 3
          });
        }
      });

    const seen = new Set();
    return events
      .filter((event) => {
        if (seen.has(event.key)) return false;
        seen.add(event.key);
        return true;
      })
      .sort((a, b) => b.at - a.at || a.order - b.order)
      .slice(0, maxItems);
  }

  function render(events) {
    const list = document.getElementById(listId);
    if (!list) return;
    if (!events.length) {
      list.innerHTML = '<div class="broadcast-history-empty">目前沒有訊號紀錄</div>';
      return;
    }
    list.innerHTML = events.map((event) => `
      <article class="broadcast-history-item${event.isLoss ? " loss" : ""}">
        <span class="broadcast-history-bar" aria-hidden="true"></span>
        <div class="broadcast-history-main">
          <div class="broadcast-history-title"><strong>${escapeHtml(event.symbol)}</strong></div>
          <p>${escapeHtml(event.desc)}</p>
        </div>
      </article>
    `).join("");
  }

  async function refreshBroadcastHistory() {
    const list = document.getElementById(listId);
    if (!list || window.CatMaintenance) return;
    try {
      const response = await fetch("/api/orders", { cache: "no-store" });
      if (!response.ok) throw new Error("orders " + response.status);
      const orders = await response.json();
      render(buildEvents(Array.isArray(orders) ? orders : []));
    } catch {
      render([]);
    }
  }

  function bind() {
    const button = document.getElementById(buttonId);
    const wrap = button && button.closest(menuWrapSelector);
    if (!button || !wrap || button.dataset.timelineFixed === "1") return;
    button.dataset.timelineFixed = "1";
    button.addEventListener("click", () => {
      setTimeout(refreshBroadcastHistory, 0);
    });
    refreshBroadcastHistory();
    setInterval(refreshBroadcastHistory, 30000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bind);
  } else {
    bind();
  }
})();
