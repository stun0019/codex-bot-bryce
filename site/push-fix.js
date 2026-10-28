(function () {
  // 與主程式共用同一把 localStorage key（之前誤用 cat-signal-notification-settings-v1，
  // 主程式永遠讀不到 push=true）。
  const SETTINGS_KEY = "cat-notification-settings-v1";
  const SETTINGS_CHANGED_EVENT = "cat:notification-settings-changed";
  // 主程式設定鍵：缺少時一律視為 true（push 例外，由訂閱成功才設 true）。
  const BOOLEAN_KEYS = ["entry", "tp", "sl", "hedge", "ftp", "raisedSl", "push", "sound"];
  const TOGGLE_IDS = {
    entry: "entryNotifyToggle",
    tp: "tpNotifyToggle",
    sl: "slNotifyToggle",
    hedge: "hedgeNotifyToggle",
    ftp: "ftpNotifyToggle",
    raisedSl: "raisedSlNotifyToggle",
    sound: "soundNotifyToggle"
  };

  function urlBase64ToUint8Array(value) {
    const padding = "=".repeat((4 - (value.length % 4)) % 4);
    const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64);
    return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
  }

  function readSettings() {
    try {
      const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  // 只合併、不覆蓋：保留主程式的其他鍵（toast 等）。
  function writeSettings(patch) {
    const next = { ...readSettings(), ...patch };
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    } catch (error) {
      console.warn("push-fix: settings write failed", error);
    }
    return next;
  }

  // 優先讀畫面上的勾選框；沒有該勾選框（例如 sl / raisedSl 尚未加到選單）就用已存設定，再退回 true。
  function settingValue(key, stored) {
    const id = TOGGLE_IDS[key];
    const input = id ? document.getElementById(id) : null;
    if (input && typeof input.checked === "boolean") return input.checked;
    if (typeof stored[key] === "boolean") return stored[key];
    return true;
  }

  function collectSettings() {
    const stored = readSettings();
    const settings = {};
    BOOLEAN_KEYS.forEach((key) => {
      settings[key] = key === "push" ? true : settingValue(key, stored);
    });
    return settings;
  }

  function notifySettingsChanged(settings) {
    try {
      window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT, { detail: settings }));
    } catch (error) {
      console.warn("push-fix: settings event dispatch failed", error);
    }
  }

  async function enableDevicePush(button) {
    if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      throw new Error("這個瀏覽器不支援裝置推播");
    }

    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      throw new Error("請允許通知權限後再啟用");
    }

    const registration = await navigator.serviceWorker.register("./sw.js", { scope: "./" });
    const ready = await navigator.serviceWorker.ready;
    const keyPayload = await fetch("/api/push/public-key", { cache: "no-store" }).then((response) => response.json());
    if (!keyPayload.enabled || !keyPayload.publicKey) {
      throw new Error("裝置推播設定尚未啟用");
    }

    let subscription = await withTimeout(
      ready.pushManager.getSubscription(),
      10000,
      "讀取裝置推播訂閱逾時"
    );
    if (!subscription) {
      subscription = await withTimeout(
        ready.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(keyPayload.publicKey)
        }),
        25000,
        "裝置推播訂閱逾時，請確認瀏覽器允許通知，手機請用加入主畫面的網站開啟"
      );
    }

    // 送給後端的設定包含全部鍵（含新加的 sl / raisedSl）。
    const settings = collectSettings();

    const response = await withTimeout(fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription, settings })
    }), 15000, "裝置推播寫入逾時，請稍後再試");
    if (!response.ok) {
      throw new Error("裝置推播訂閱寫入失敗");
    }

    const saved = writeSettings(settings);
    notifySettingsChanged(saved);
    if (button) {
      button.textContent = "已啟用裝置推播";
      button.disabled = false;
    }
  }

  function withTimeout(promise, ms, message) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  function bind() {
    const button = document.getElementById("enablePushButton");
    if (!button || button.dataset.pushFixBound === "1") return;
    button.dataset.pushFixBound = "1";
    // 以 capture 搶在主程式的 click handler 前面並 stopImmediatePropagation，
    // 由這裡接手整個訂閱流程；主程式改由 cat:notification-settings-changed 事件得知 push 已啟用。
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      const originalText = button.textContent;
      button.disabled = true;
      button.textContent = "啟用中";
      try {
        await enableDevicePush(button);
      } catch (error) {
        button.disabled = false;
        button.textContent = originalText || "啟用裝置推播";
        console.warn("push-fix: enable device push failed", error);
        alert(error?.message || "裝置推播啟用失敗");
      }
    }, true);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bind);
  } else {
    bind();
  }
})();
