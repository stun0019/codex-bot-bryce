(() => {
  "use strict";

  const ADMIN_PAGE = document.body?.dataset?.page === "admin";
  const RAISED_SL_LABEL = "上移止損";
  const MOVING_PROFIT_LABEL = "移動止盈";
  const EDIT_LABEL = "修改";
  const EMPTY_LABEL = "未設定";
  const PRICE_PROXY_URL = "/api/bingx/price?symbol=";
  const PRICE_PROXY_MIN_INTERVAL_MS = 60 * 1000;

  // 管理員代碼：主程式提供 window.CatAdmin；沒有時才退回舊的 bigbird.chug/<token> 路徑規則。
  const getAdminCodeFromPath = () => {
    const parts = location.pathname.split("/").filter(Boolean);
    const marker = parts.indexOf("bigbird.chug");
    return marker >= 0 ? decodeURIComponent(parts[marker + 1] || "") : "";
  };

  const getAdminCode = () => {
    try {
      if (typeof window.CatAdmin?.code === "function") return String(window.CatAdmin.code() || "");
    } catch (error) {
      console.warn("raised-sl: CatAdmin.code failed", error);
    }
    return getAdminCodeFromPath();
  };

  const getAdminHeaders = () => {
    try {
      if (typeof window.CatAdmin?.headers === "function") {
        const headers = window.CatAdmin.headers();
        if (headers && typeof headers === "object") return { ...headers };
      }
    } catch (error) {
      console.warn("raised-sl: CatAdmin.headers failed", error);
    }
    const code = getAdminCodeFromPath();
    return code ? { "x-admin-code": code } : {};
  };

  const cleanSymbol = (value) => String(value || "").replace(/[^A-Z0-9]/gi, "").toUpperCase();
  const cleanTime = (value) => String(value || "").trim().replace(/\s+/g, " ");
  const isValidNumber = (value) => Number.isFinite(Number(String(value || "").replace(/,/g, "").trim()));
  const numberValue = (value) => Number(String(value || "").replace(/,/g, "").trim());
  const orderKey = (order) => `${cleanSymbol(order.symbol)}|${cleanTime(order.time)}`;

  // 從 DOM 元素讀訂單 id：article[data-order-id] → .like-button[data-signal-id] → 管理表格的 [data-ftp-id]。
  const orderIdFromElement = (element) => {
    if (!element) return "";
    const own = element.dataset?.orderId || element.dataset?.signalId || element.dataset?.ftpId;
    if (own) return String(own);
    const nested = element.querySelector?.("[data-order-id], [data-signal-id], [data-ftp-id]");
    if (!nested) return "";
    return String(nested.dataset.orderId || nested.dataset.signalId || nested.dataset.ftpId || "");
  };

  // 先用 id，再退回 symbol|time。
  const findOrderForElement = (element, ordersById, ordersByKey, fallbackKey) => {
    const id = orderIdFromElement(element);
    if (id && ordersById.has(id)) return ordersById.get(id);
    if (fallbackKey && ordersByKey.has(fallbackKey)) return ordersByKey.get(fallbackKey);
    return undefined;
  };

  async function fetchOrders() {
    if (window.CatMaintenance) throw new Error("maintenance");
    const response = await fetch("/api/orders", { cache: "no-store" });
    // 503 可能是維護模式，也可能只是 Redis 暫時失敗；維護旗標只由主程式依回應的 maintenance:true 設定
    if (!response.ok) throw new Error("orders " + response.status);
    const data = await response.json();
    return Array.isArray(data) ? data : [];
  }

  async function patchOrder(id, body, adminCode = "") {
    const code = adminCode || getAdminCode();
    const headers = {
      "Content-Type": "application/json",
      ...getAdminHeaders(),
      ...(code ? { "x-admin-code": code } : {})
    };
    const response = await fetch(`/api/orders/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(code ? { ...body, code } : body)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data?.error || "update " + response.status;
      // 403 = 未授權寫入（伺服器現在會擋沒有管理員代碼的 PATCH），一律用 console.warn 讓它浮出來。
      console.warn(`raised-sl: PATCH ${id} ${body?.action || ""} failed (${response.status})`, message);
      throw new Error(message);
    }
    return data;
  }

  function installAdminRaisedStopColumn() {
    const rows = document.getElementById("adminPositionRows");
    const table = document.querySelector("#adminPositionPanel .admin-position-table");
    if (!rows || !table) return false;

    table.style.minWidth = "980px";
    const headerRow = table.querySelector("thead tr");
    if (headerRow && !headerRow.querySelector("[data-raised-sl-head]")) {
      const th = document.createElement("th");
      th.dataset.raisedSlHead = "1";
      th.textContent = RAISED_SL_LABEL;
      headerRow.insertBefore(th, headerRow.children[3] || null);
    }

    const stalePanel = document.getElementById("raisedSlPanel");
    if (stalePanel) stalePanel.remove();

    let ordersByKey = new Map();
    let ordersById = new Map();
    let applying = false;

    const refreshOrders = async () => {
      if (window.CatMaintenance) return;
      try {
        const orders = await fetchOrders();
        ordersByKey = new Map(orders.map((order) => [orderKey(order), order]));
        ordersById = new Map(orders.filter((order) => order?.id).map((order) => [String(order.id), order]));
        applyCells();
      } catch (error) {
        console.warn("raised stop orders refresh failed", error);
      }
    };

    const makeCell = (order) => {
      const cell = document.createElement("td");
      cell.className = "raised-sl-cell";
      cell.dataset.raisedSlCell = "1";

      if (!order?.id) {
        cell.textContent = EMPTY_LABEL;
        return cell;
      }

      const editor = document.createElement("span");
      editor.className = "position-ftp-editor raised-sl-editor";

      const input = document.createElement("input");
      input.className = "position-ftp-input raised-sl-input";
      input.type = "text";
      input.inputMode = "decimal";
      input.autocomplete = "off";
      input.value = String(order.raisedSl || "");
      input.placeholder = EMPTY_LABEL;
      input.setAttribute("aria-label", RAISED_SL_LABEL);

      const button = document.createElement("button");
      button.className = "position-ftp-save raised-sl-save";
      button.type = "button";
      button.textContent = EDIT_LABEL;
      button.addEventListener("click", async () => {
        const value = input.value.trim();
        if (!isValidNumber(value)) {
          alert("請輸入正確的上移止損價格");
          input.focus();
          return;
        }
        const nextRaisedStop = numberValue(value);
        const entryPrice = numberValue(order.entry || order.trigger);
        if (Number.isFinite(entryPrice) && nextRaisedStop < entryPrice) {
          alert("移動止損價格不得低於進場價格");
          input.focus();
          return;
        }
        if (!confirm(`確認將 ${cleanSymbol(order.symbol)} ${RAISED_SL_LABEL}改為 ${value}？`)) return;
        button.disabled = true;
        try {
          await patchOrder(order.id, { action: "raised-sl", raisedSl: value }, getAdminCode());
          order.raisedSl = value;
          input.value = value;
          alert(`${RAISED_SL_LABEL}已更新`);
          await refreshOrders();
        } catch (error) {
          alert(`上移止損更新失敗：${error?.message || "請稍後再試"}`);
        } finally {
          button.disabled = false;
        }
      });

      editor.append(input, button);
      cell.append(editor);
      return cell;
    };

    function applyCells() {
      if (applying) return;
      applying = true;
      try {
        Array.from(rows.querySelectorAll("tr")).forEach((row) => {
          const cells = Array.from(row.children);
          if (!cells.length || row.querySelector("[data-raised-sl-cell]")) return;
          const symbol = cleanSymbol(cells[0]?.textContent);
          const time = cleanTime(cells[cells.length - 1]?.textContent);
          const order = findOrderForElement(row, ordersById, ordersByKey, `${symbol}|${time}`);
          row.insertBefore(makeCell(order), row.children[3] || null);
        });
      } finally {
        applying = false;
      }
    }

    const observer = new MutationObserver(() => {
      if (!applying) setTimeout(applyCells, 0);
    });
    observer.observe(rows, { childList: true, subtree: false });

    refreshOrders();
    return true;
  }

  function replaceDirectText(element, from, to) {
    if (!element) return;
    Array.from(element.childNodes).forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE && node.nodeValue.includes(from)) {
        node.nodeValue = node.nodeValue.replaceAll(from, to);
      }
    });
  }

  function applyMovingProfitDisplay() {
    document.querySelectorAll(".signal-card").forEach((card) => {
      if (!card.textContent.includes(RAISED_SL_LABEL) && !card.textContent.includes(MOVING_PROFIT_LABEL)) return;
      card.classList.add("moving-profit-card");
      card.querySelectorAll("*").forEach((element) => {
        if (element.children.length === 0 && element.textContent.includes(RAISED_SL_LABEL)) {
          element.textContent = element.textContent.replaceAll(RAISED_SL_LABEL, MOVING_PROFIT_LABEL);
        } else {
          replaceDirectText(element, RAISED_SL_LABEL, MOVING_PROFIT_LABEL);
        }
      });
    });
  }

  function installMovingProfitStyles() {
    if (document.getElementById("movingProfitDisplayStyle")) return;
    const style = document.createElement("style");
    style.id = "movingProfitDisplayStyle";
    style.textContent = `
      .signal-card.moving-profit-card .price-box.reached {
        border-color: transparent !important;
        box-shadow: none !important;
      }
      .signal-card.moving-profit-card .price-box.reached .box-label,
      .signal-card.moving-profit-card .price-box.reached strong {
        color: inherit !important;
      }
      .signal-card.moving-profit-card .box-label b {
        display: none !important;
      }
    `;
    document.head.appendChild(style);
  }

  function initPublicDisplayFix() {
    installMovingProfitStyles();
    applyMovingProfitDisplay();
    const target = document.getElementById("signalsList") || document.body;
    const observer = new MutationObserver(() => applyMovingProfitDisplay());
    observer.observe(target, { childList: true, subtree: true });
  }

  function initAdmin() {
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      if (installAdminRaisedStopColumn() || tries > 80) clearInterval(timer);
    }, 250);
  }

  const isClosed = (order) => {
    const label = String(order?.reachedLabel || "").trim().toUpperCase();
    const status = String(order?.status || "");
    const finalType = String(order?.finalType || "");
    return Boolean(order?.resultLocked)
      || label === "SL"
      || label === "FTP"
      || label === "RAISED_SL"
      || finalType === "loss"
      || status.includes("止損")
      || status.includes("FTP")
      || status.includes("上移止損");
  };

  // 同站代理備援節流：每個幣對 60 秒最多打一次 /api/bingx/price。
  const proxyLastCallAt = new Map();

  async function fetchProxyPrice(pair) {
    const now = Date.now();
    const last = proxyLastCallAt.get(pair) || 0;
    if (now - last < PRICE_PROXY_MIN_INTERVAL_MS) return null;
    proxyLastCallAt.set(pair, now);
    const response = await fetch(PRICE_PROXY_URL + encodeURIComponent(pair), { cache: "no-store" });
    if (!response.ok) {
      console.warn(`raised-sl: price proxy ${pair} ${response.status}`);
      return null;
    }
    const data = await response.json().catch(() => ({}));
    const raw = data?.data?.price ?? data?.price;
    const price = Number(raw);
    return Number.isFinite(price) ? price : null;
  }

  async function fetchBingxPrice(symbol) {
    const pair = cleanSymbol(symbol).replace(/USDT$/i, "-USDT");
    if (!pair) return null;
    // 優先用 price-feed.js 的 WebSocket 快取
    if (window.CatPriceFeed) {
      try {
        const live = await window.CatPriceFeed.price(pair);
        if (Number.isFinite(live)) return live;
      } catch (error) {
        console.warn(`raised-sl: CatPriceFeed.price ${pair} failed`, error);
      }
    }
    // BingX REST 對帶瀏覽器 Origin 的請求回 403，所以備援改走同站代理（有節流）。
    return fetchProxyPrice(pair);
  }

  async function checkRaisedStopHits() {
    if (window.CatMaintenance) return;
    let orders = [];
    try {
      orders = await fetchOrders();
    } catch (error) {
      console.warn("raised stop public orders refresh failed", error);
      return;
    }

    for (const order of orders) {
      if (window.CatMaintenance) return;
      const raised = Number(String(order?.raisedSl || "").replace(/,/g, "").trim());
      if (!order?.id || !Number.isFinite(raised)) continue;
      // 已鎖定結果或已經是 RAISED_SL 的訂單不再檢查。
      if (order.resultLocked || String(order.reachedLabel || "").trim().toUpperCase() === "RAISED_SL") continue;
      if (isClosed(order) || order.raisedSlTriggeredAt) continue;
      const key = `raised-sl-hit:${order.id}:${order.raisedSl}`;
      if (localStorage.getItem(key)) continue;
      try {
        const price = await fetchBingxPrice(order.symbol);
        if (price !== null && price <= raised) {
          localStorage.setItem(key, String(Date.now()));
          await patchOrder(order.id, { action: "raised-sl-hit" });
        }
      } catch (error) {
        console.warn("raised stop hit check failed", error);
      }
    }
  }

  if (ADMIN_PAGE) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initAdmin, { once: true });
    else initAdmin();
  } else {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initPublicDisplayFix, { once: true });
    else initPublicDisplayFix();
    window.setTimeout(checkRaisedStopHits, 1500);
    window.setInterval(checkRaisedStopHits, 15000);
  }
})();
