(function () {
  "use strict";
  const $ = id => document.getElementById(id), client = window.RsiVolume.createClient();
  const panel = $("rsi-volume"), list = $("rsiVolumeList"), status = $("rsiVolumeStatus"), runButton = $("rsiVolumeRun");
  let controller = null, busy = false, state = null, taps = 0, lastTap = 0, queued = false, leaving = false;
  const number = n => n.toLocaleString("en-US", { maximumSignificantDigits: 10 });
  const time = n => new Date(n).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false });
  function node(tag, className, text) { const e = document.createElement(tag); if (className) e.className = className; if (text != null) e.textContent = text; return e; }
  function render() {
    runButton.disabled = busy; $("rsiVolumeCancel").disabled = !busy;
    $("rsiVolumeCount").textContent = "(" + (state?.matches.length || 0) + ")";
    $("rsiVolumeMeter").max = state?.total || 1; $("rsiVolumeMeter").value = state?.completed || 0;
    $("rsiVolumeProgress").textContent = state ? "已檢查 " + state.completed + " / " + state.total + " · 資料錯誤 " + state.errors + " · 符合 " + state.matches.length : "等待策略掃描啟動";
    $("rsiVolumeTime").textContent = state ? "15M 收盤快照 " + time(state.confirmedAt) + "（台北）" : "";
    list.replaceChildren();
    const matches = [...(state?.matches || [])].sort((a, b) => a.rsi - b.rsi || a.symbol.localeCompare(b.symbol));
    if (!matches.length) list.append(node("div", "strategy-empty", busy ? "掃描中，尚無符合結果" : state ? "本輪已檢查的合約中沒有符合結果" : "每次策略掃描時同步檢查所有 USDT 永續合約"));
    for (const match of matches) {
      const card = node("article", "strategy-card rsi-volume-card"), head = node("div", "strategy-card-head");
      head.append(node("h3", "strategy-symbol", match.symbol), node("span", "strategy-badge", "RSI＋爆量"));
      const values = node("dl", "strategy-prices");
      for (const [label, value] of [["15M 收盤價", number(match.close)], ["RSI (14)", match.rsi.toFixed(2)], ["成交量增加", "+" + match.volumeGrowth.toFixed(1) + "%"], ["前根倍數", match.volumeRatio.toFixed(2) + "×"]]) {
        const item = node("div", "strategy-metric"); item.append(node("dt", "", label), node("dd", "", value)); values.append(item);
      }
      const details = node("details", "strategy-details"); details.append(node("summary", "", "詳細資訊"),
        node("p", "", "本根成交量 " + number(match.volume) + " · 前根 " + number(match.previousVolume) + "（基礎資產數量）"),
        node("p", "", "15M 收盤 " + time(match.confirmedAt) + " · RSI 使用 Wilder 平滑"));
      card.append(head, values, details); list.append(card);
    }
    const failures = $("rsiVolumeFailures"); failures.replaceChildren();
    for (const failure of state?.failures || []) failures.append(node("li", "", failure.symbol + "：" + failure.message));
    $("rsiVolumeErrors").hidden = !state?.errors;
  }
  async function run() {
    if (busy) return;
    if (Date.now() < client.getBackoffUntil()) { status.textContent = "幣安限流，請於 " + time(client.getBackoffUntil()) + " 後更新"; return; }
    busy = true; state = null; controller = new AbortController();
    status.textContent = "背景掃描中 · 全合約結果逐步更新"; status.dataset.state = "pending"; render();
    try {
      state = await client.scan({ signal: controller.signal, onProgress(next) { state = next; render(); } });
      status.textContent = state.errors ? "掃描完成但有資料錯誤 · 結果不完整" : "全合約掃描完成";
      status.dataset.state = state.errors ? "error" : "live";
    } catch (error) {
      status.textContent = (error.name === "AbortError" ? "掃描已取消" : error.message) + " · 目前結果不完整";
      status.dataset.state = "error";
    } finally { busy = false; controller = null; render(); if (queued && !leaving) { queued = false; void run(); } }
  }
  document.querySelector(".brand").addEventListener("click", event => {
    const at = Date.now(); taps = at - lastTap <= 1200 ? taps + 1 : 1; lastTap = at;
    if (taps >= 5) { taps = 0; event.preventDefault(); location.hash = "rsi-volume"; }
  });
  runButton.addEventListener("click", () => void run());
  $("rsiVolumeCancel").addEventListener("click", () => { queued = false; controller?.abort(); });
  $("rsiVolumeClose").addEventListener("click", () => { location.hash = "signals"; });
  window.addEventListener("strategy-scan-start", () => { if (busy) queued = true; else void run(); });
  window.addEventListener("pagehide", () => { leaving = true; queued = false; controller?.abort(); });
  setInterval(() => {
    if (!busy && state && Date.now() + state.serverOffset >= state.confirmedAt + window.RsiVolume.INTERVAL) {
      $("rsiVolumeTime").textContent = "舊快照 " + time(state.confirmedAt) + "（台北）· 等待下一輪掃描";
    }
  }, 1000);
  render();
})();
