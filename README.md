# Quant Pocket 口袋量化

適合手機的繁體中文雙均線回測工具，純 HTML / CSS / JavaScript，無須安裝套件或 API 金鑰。

## 使用

直接開啟 `index.html`，或執行 `node server.cjs` 後開啟 http://localhost:8080 。頁面載入後自動回測並顯示績效、圖表與交易紀錄，可匯出交易 CSV。

策略設定面板與規則說明已移除。參數集中於 `app.js` 的 `strategy` 常數，交易邏輯位於 `engine.js`。預設使用合成示範資料。GitHub Pages 的前端程式仍可透過瀏覽器檢視原始碼；若需要保密策略，應改由後端執行，僅發布計算結果。

## GitHub Pages

1. 將此資料夾內容提交並推送到你的 GitHub 儲存庫。
2. GitHub 儲存庫 → Settings → Pages。
3. Source 選 **Deploy from a branch**，選擇放置檔案的分支（例如 main）與 **/(root)**，按 Save。
4. 等待 GitHub 部署完成，從 Pages 畫面取得網址；手機瀏覽器開啟後，可加入主畫面。

所有資源使用相對路徑，支援 `https://帳號.github.io/儲存庫名稱/`。除了可選的 Google Fonts，沒有外部依賴；字型無法連線時會使用系統字型。

## 計算方式

- 短 SMA 向上穿越長 SMA，下一筆收盤全額買入；向下穿越，下一筆收盤全額賣出。首筆有效均線只建立比較狀態。最後一筆訊號無法成交。
- 單向現貨做多，不做空、不加槓桿；持倉期間不重複買入。
- 買入價為收盤價 × (1 + 滑價率)，賣出價為收盤價 × (1 − 滑價率)；每筆成交依成交金額扣單邊手續費。
- 買入持有基準在第一筆價格買入，同樣扣買入費用與滑價；與策略一樣，期末依收盤估值而未強制賣出。
- 最大回撤使用每天資產相對歷史最高值（含初始資金）的跌幅；勝率只統計已平倉交易，盈虧扣買賣費用。
- 期末持倉市值不扣尚未發生的平倉費用；沒有模擬流動性、最小下單量、資金費率或稅負。

靈感來源：https://www.threads.com/@cengwei0529/post/DULY5-RD6R3 。原文未公開策略，本程式為獨立示範，無法複製原作者的績效。

本工具用於學習與模擬，不提供獲利保證，亦無實盤下單功能。GitHub Pages 只提供靜態頁面，關閉頁面後不會持續執行交易機器人。

## 驗證

執行 `node --test tests/engine.test.cjs`。

## PAGE 2

上方 PAGE 2 或 #page2 可切換策略監控。

- PANEL 1：原示範回測累積盈虧（含未實現）、已平倉勝率、TP1～TP4 觸及率。
- TP 目標依序為 2R、3R、4R、5R；暫定 1R = 實際入場價的 2%，因此目標為 +4%、+6%、+8%、+10%。使用已平倉交易作分母，持倉期間收盤價最高值判定觸及；不含未平倉交易，不執行 TP/SL 出場。不是 K 線高點觸及率。
- PANEL 2：Binance USDT 永續合約，篩選交易中合約，按 24 小時 USDT 成交額選前 20 名。日線 SMA 10/30 最新已收盤 K 線向上交叉才列入清單；新上架且資料不足者會記為失敗。訊號為收盤價參考，非成交價。
- 首次進入 PAGE 2 掃描；重新掃描按鈕手動更新，無背景定時輪詢。訊號時間與更新時間以台北時間呈現。
- 公開行情端點：exchangeInfo、ticker/24hr、time、klines，不需要 API key。API 受地區、網路、CORS 或限流影響時顯示錯誤，部分失敗明確顯示掃描覆蓋率。
- 績效為合成回測，掃描為即時資料，兩者非同一實盤帳戶。純前端工具不下單。

API 來源：https://developers.binance.info/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data
