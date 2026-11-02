# Codex Bot Bryce — Binance 行情版

此版本將前端行情來源改為 Binance USDT 永續合約，保留既有策略、訊號訂單格式與雷達評分邏輯。

## 行情來源

- 合約清單：`https://fapi.binance.com/fapi/v1/exchangeInfo`，只接受交易中的 USDT 永續合約。
- 即時成交與 24h ticker：`wss://fstream.binance.com/market/stream`。
- 最佳買賣報價：`wss://fstream.binance.com/public/stream`。
- REST 備援：`https://fapi.binance.com/fapi/v2/ticker/price`。
- 公開行情不需設定 API Key，也不會透過本模組下單。

既有訂單仍使用 BTC-USDT 這類格式。PEPE、BONK、SHIB、FLOKI 等幣種會在幣安提供相應千倍合約時，自動換算為單顆幣價格與成交量，避免影響原本價位的判定。直接輸入 1000PEPE 時則保留該合約本身的單位。未提供或非交易中的合約會標示不可用，不會以其他幣種替代。

連線中斷後自動重連，控制訊息合併發送；過期價格不會當作新的即時價格。REST 備援依幣種節流，相同幣種的並行請求會共用結果。

## 使用與範圍

將 `site/` 放到原本的網站服務即可。專案根目錄的 `index.html` 也會導向 `site/`。更新後重新整理頁面；已更新修改檔案的版本參數。

此儲存庫只有前端，既有 `/api/orders`、管理員、統計及裝置推播等後端服務並未包含在內，這些功能仍需要原有後端。此次只修改本機專案，未部署或推送 GitHub；也未更動未提供的後端行情來源。

## 驗證

使用 Node.js 24 執行：

```powershell
node --test tests/*.test.cjs
```

自動測試涵蓋雷達評分、行情解析、分流訂閱、合約單位換算、無效合約、過期與異常價格、REST 備援及重連。

已從本機實際驗證 BTC 與 PEPE 的幣安 REST 取價，以及即時成交、24h ticker、最佳買賣報價。網站部署環境及瀏覽器網路政策仍需在該環境驗證。
