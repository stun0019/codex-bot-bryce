(function () {
  'use strict';
  const client = window.StrategyData.createClient();
  const $ = id => document.getElementById(id);
  const list = $('strategyList'), directionFilter = $('directionFilter');
  const timeframeFilter = $('timeframeFilter'), refresh = $('refreshBtn');
  let rows = [], busy = false, nextScanAt = 0, offset = 0, controller = null;

  $('rsiEntryFilter').checked = false;
  $('rsiEntryFilter').closest('label').hidden = true;
  $('candidateRecordStatus').textContent = '大框架均線定方向；15M／5M顯示近期高低點與結構，進場由你判斷。';

  function render() {
    const openDetails = new Set([...list.querySelectorAll('article details[open]')]
      .map(details => details.closest('article').dataset.key));
    const visible = rows.filter(row =>
      (directionFilter.value === 'all' || row.direction === directionFilter.value) &&
      (timeframeFilter.value === 'all' || row.profileId === timeframeFilter.value));
    list.replaceChildren();
    $('candidateCount').textContent = '(' + visible.length + ' 候選)';
    window.DashboardUI?.setCandidates(visible.length);
    if (!visible.length) {
      const empty = document.createElement('div');
      empty.className = 'strategy-empty';
      empty.textContent = busy ? '正在檢查4H、1H SMA83／EMA200方向' : '目前篩選下沒有均線方向候選';
      list.append(empty);
      return;
    }
    for (const group of window.MarketGroups.split(visible)) {
      list.append(window.MarketGroups.heading(group));
      for (const row of group.items) {
        const card = window.TradeCards.render(
          { ...row, strategyVersion: window.MacdStrategy.VERSION },
          { watch: true, now: Date.now() + offset });
        if (openDetails.has(card.dataset.key)) card.querySelector('details').open = true;
        list.append(card);
      }
    }
  }

  async function run() {
    if (busy) return;
    busy = true;
    refresh.disabled = true;
    refresh.textContent = '掃描中…';
    controller = new AbortController();
    window.PaperTrading?.beginScan();
    window.dispatchEvent(new Event('strategy-scan-start'));
    $('scannerStatus').textContent = '策略掃描中';
    $('scannerStatus').dataset.state = 'pending';
    list.setAttribute('aria-busy', 'true');
    render();
    try {
      const result = await client.scan({
        signal: controller.signal,
        onProgress(state) {
          offset = state.serverOffset;
          const tradfi = state.rankedMarkets.filter(m => m.contractType === 'TRADIFI_PERPETUAL').length;
          $('scanProgress').textContent = '合併成交額 Top20（加密 ' +
            (state.rankedMarkets.length - tradfi) + '／TradFi ' + tradfi +
            '）· 週期組合 ' + state.completed + ' / ' + state.total +
            ' · 方向候選 ' + state.trending + (state.errors ? ' · 資料不可用 ' + state.errors : '');
          $('scanMeter').max = state.total;
          $('scanMeter').value = state.completed;
        }
      });
      rows = result.observations.filter(row => row.direction && row.status !== 'ERROR')
        .sort((a, b) => b.quoteVolume24h - a.quoteVolume24h ||
          a.symbol.localeCompare(b.symbol) || a.profileId.localeCompare(b.profileId));
      // Candidates are observations, not executable orders.
      window.PaperTrading?.reconcileCandidates([], result.observations, result.asOf);
      window.PaperTrading?.acceptCandidates([], 200, result.asOf, true);
      const symbols = [...new Set(rows.map(row => row.symbol))];
      window.CatPriceFeed?.setScannerSymbols(symbols);
      window.dispatchEvent(new CustomEvent('strategy-scan-complete', {
        detail: { symbols, at: result.asOf }
      }));
      $('scannerStatus').textContent = result.errors ? '掃描完成 · 部分資料不可用' : '掃描完成';
      $('scannerStatus').dataset.state = result.errors ? 'partial' : 'live';
      $('lastUpdate').dateTime = new Date(result.asOf).toISOString();
      $('lastUpdate').textContent = '更新於 ' + new Date(result.asOf).toLocaleString('zh-TW', {
        timeZone: 'Asia/Taipei', hour12: false
      }) + '（台北）';
      nextScanAt = Math.floor(result.asOf / 300000 + 1) * 300000 + 3000;
    } catch (error) {
      rows = [];
      window.CatPriceFeed?.setScannerSymbols([]);
      $('scannerStatus').textContent = error.name === 'AbortError' ? '掃描已停止' : '掃描失敗';
      $('scannerStatus').dataset.state = 'error';
      $('scanProgress').textContent = error.message;
      nextScanAt = Math.max(error.retryAt || 0, Date.now() + 60000) + offset;
    } finally {
      busy = false;
      controller = null;
      refresh.disabled = false;
      refresh.textContent = '更新';
      list.setAttribute('aria-busy', 'false');
      render();
    }
  }

  directionFilter.addEventListener('change', render);
  timeframeFilter.addEventListener('change', render);
  refresh.addEventListener('click', () => {
    if (Date.now() >= client.getBackoffUntil()) void run();
  });
  window.CatPriceFeed?.subscribe(() => {
    if (document.visibilityState !== 'hidden') render();
  });
  window.addEventListener('pagehide', () => controller?.abort());
  setInterval(() => {
    if (document.visibilityState !== 'hidden' && !busy &&
        Date.now() + offset >= nextScanAt && navigator.onLine !== false) void run();
  }, 1000);
  void run();
})();
