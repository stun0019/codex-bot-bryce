(function () {
  "use strict";

  var STORE_KEY = "cat-notification-client-dedupe-v2";
  var TTL_MS = 30 * 24 * 60 * 60 * 1000;
  var MAX_ITEMS = 300;

  function readStore() {
    try {
      var parsed = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (error) {
      return {};
    }
  }

  function writeStore(store) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(store));
    } catch (error) {
      // Ignore storage quota/private mode errors.
    }
  }

  function notificationKey(title, options) {
    var tag = String(options && options.tag ? options.tag : "").trim();
    if (tag) return "tag:" + tag;
    return "body:" + String(title || "") + "|" + String(options && options.body ? options.body : "");
  }

  function shouldSkip(title, options) {
    var now = Date.now();
    var store = readStore();
    var key = notificationKey(title, options);
    var last = Number(store[key] || 0);
    var keys = Object.keys(store);

    keys.forEach(function (itemKey) {
      if (now - Number(store[itemKey] || 0) > TTL_MS) delete store[itemKey];
    });

    if (keys.length > MAX_ITEMS) {
      Object.keys(store)
        .sort(function (a, b) { return Number(store[a] || 0) - Number(store[b] || 0); })
        .slice(0, Math.max(0, keys.length - MAX_ITEMS))
        .forEach(function (itemKey) { delete store[itemKey]; });
    }

    if (last && now - last < TTL_MS) {
      writeStore(store);
      return true;
    }

    store[key] = now;
    writeStore(store);
    return false;
  }

  if ("ServiceWorkerRegistration" in window) {
    var registrationProto = ServiceWorkerRegistration.prototype;
    var originalShowNotification = registrationProto.showNotification;
    if (originalShowNotification && !registrationProto.__catDedupePatched) {
      Object.defineProperty(registrationProto, "__catDedupePatched", { value: true });
      registrationProto.showNotification = function (title, options) {
        if (shouldSkip(title, options || {})) return Promise.resolve();
        return originalShowNotification.call(this, title, options);
      };
    }
  }

  if ("Notification" in window && !Notification.__catDedupePatched) {
    var NativeNotification = Notification;
    var SilentNotification = function () {};
    SilentNotification.prototype.close = function () {};
    SilentNotification.prototype.addEventListener = function () {};
    SilentNotification.prototype.removeEventListener = function () {};
    SilentNotification.prototype.dispatchEvent = function () { return false; };

    var WrappedNotification = function (title, options) {
      if (!(this instanceof WrappedNotification)) {
        return NativeNotification(title, options);
      }
      if (shouldSkip(title, options || {})) return new SilentNotification();
      return new NativeNotification(title, options);
    };

    Object.getOwnPropertyNames(NativeNotification).forEach(function (name) {
      try {
        Object.defineProperty(WrappedNotification, name, Object.getOwnPropertyDescriptor(NativeNotification, name));
      } catch (error) {
        // Some browser properties are not configurable.
      }
    });
    WrappedNotification.prototype = NativeNotification.prototype;
    Object.defineProperty(WrappedNotification, "__catDedupePatched", { value: true });
    window.Notification = WrappedNotification;
  }
})();
