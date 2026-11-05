const CACHE_VERSION = "cat-signal-runtime-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

// 原本的 fetch handler 只是 event.respondWith(fetch(event.request))，
// 等於每個請求都多繞一趟 SW 卻沒有任何快取效果，已移除。

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : "" };
  }

  const title = payload.title || "Codex Bot";
  const options = {
    body: payload.body || "",
    tag: payload.tag || `cat-push-${Date.now()}`,
    renotify: true,
    data: {
      url: payload.url || self.registration.scope
    }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const rawUrl = event.notification.data?.url || self.registration.scope;
  let targetUrl = rawUrl;
  try {
    targetUrl = new URL(rawUrl, self.location.origin).href;
  } catch {
    targetUrl = self.registration.scope;
  }

  event.waitUntil((async () => {
    try {
      const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = clientList.find((client) => String(client.url || "").startsWith(self.location.origin));
      if (existing) {
        if ("focus" in existing) await existing.focus();
        if (existing.url !== targetUrl && "navigate" in existing) {
          try {
            await existing.navigate(targetUrl);
          } catch (error) {
            // 跨 scope 或頁面拒絕導向時忽略，至少已把視窗帶到前景。
          }
        }
        return;
      }
      if (self.clients.openWindow) await self.clients.openWindow(targetUrl);
    } catch (error) {
      // notificationclick 不能丟出未處理錯誤，否則部分瀏覽器會直接吞掉點擊。
    }
  })());
});
