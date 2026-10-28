# Codex Bot 觀察後端

這是本機執行的觀察版後端。只讀取 BingX 公開的 USDT 永續合約 K 線，不需 API Key，沒有帳戶查詢、下單或自動交易功能。掃描 ZEC-USDT、ENA-USDT，獨立檢查 H4/M15 與 H1/M5。

## 家裡 Windows 電腦啟動

1. 從同一個 GitHub 倉庫取得程式碼，安裝 Python 3.12。
2. 雙擊 backend/start.bat。第一次執行會在 backend/.venv 安裝 FastAPI 和 Uvicorn。
3. 用瀏覽器開啟 http://127.0.0.1:8000/api/observer/status 查看掃描狀態，或開啟 http://127.0.0.1:8000/api/observer/candidates 查看觀察名單。後端每 60 秒掃描一次，關閉命令視窗即停止。

本機資料存於 backend/data/observer.sqlite3，不會上傳到 GitHub。開機後若要持續運行，需再次啟動 start.bat 並保持電腦與命令視窗開啟。GitHub Pages 是靜態頁面，不會自行執行後端；觀察名單只在本機後端提供的首頁出現。

## 暫定觀察規則

兩組時間框架的規則相同，但完全分開。只使用已收盤 K 線：

- 高週期由兩組連續上升或下降的確認擺動高低點判斷趨勢。
- 沿趨勢收盤突破前擺動點，取突破前最近一根反向 K 線的全影線範圍作為高週期 OB；等待高週期回踩。
- 回踩後，在低週期出現反向微趨勢，然後收盤突破其擺動點，視為 CHOCH；取突破前最近一根反向 K 線的全影線範圍作為低週期 OB。
- 低週期 OB 一形成，就加入「策略觀察名單」。不等待低週期再次回踩，亦不產生進場、止損或止盈指令。

擺動確認根數與 OB 回看根數在 StrategyConfig 可調。這是讓流程能運作的暫定定義，尚未依你的圖例驗證 OB / CHOCH 判法；觀察結果不能視為交易訊號。只儲存最新收盤低週期 K 線新形成的候選，不補登更早歷史候選。每次候選以策略版本、幣種、週期、方向與形成時間去重。

## 開發測試

在專案根目錄執行：

python -m unittest discover -s backend/tests -v

測試使用人造 K 線，不會呼叫 BingX。
