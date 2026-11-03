(function (root) {
  "use strict";
  let pending;
  function open() {
    if (pending) return pending;
    pending = new Promise((resolve, reject) => {
      if (!root.indexedDB) { reject(new Error("此瀏覽器無法使用 IndexedDB 本機儲存")); return; }
      const request = indexedDB.open("codex-strategy-lab-v1", 1);
      request.onupgradeneeded = () => {
        for (const name of ["scans", "reports", "series"]) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: "id" });
      };
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
      request.onerror = () => { pending = null; reject(request.error); };
      request.onblocked = () => { pending = null; reject(new Error("本機資料庫被另一個分頁阻擋，請關閉舊分頁後重試")); };
    });
    return pending;
  }
  async function access(name, method, value) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(name, method === "put" ? "readwrite" : "readonly");
      const request = transaction.objectStore(name)[method](value);
      let result;
      request.onsuccess = () => { result = request.result; };
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = transaction.onabort = () => reject(transaction.error || request.error || new Error("本機儲存失敗"));
    });
  }
  root.LabStore = { get: (name,id) => access(name,"get",id), put: (name,value) => access(name,"put",value),
    all: name => access(name,"getAll",undefined) };
})(typeof window !== "undefined" ? window : globalThis);
