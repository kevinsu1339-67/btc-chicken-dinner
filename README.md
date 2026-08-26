# 比特幣開盤價預測賽

9/11 00:00 (UTC+8) Coinbase Exchange BTC-USD 開盤價，賭一頓飯。

## 計分

```
膽量   = abs(預測價 − 下注當下市價) / 下注當下市價 × 100
誤差   = abs(預測價 − 9/11 開盤價) / 9/11 開盤價 × 100
容許值 = round(6 × √剩餘天數)
餐點倍數 = max(0, (1 + 膽量/10) × (1 − 誤差/容許值))
```

越早下注容許值越寬，這是早鳥機制。截止前可以隨時改注，
計分只看最新一筆，但每次送出都會在 Sheet 留下紀錄。

## 開發

```bash
node --test                # 跑測試，零依賴
./tools/build-gas.sh       # 產生要貼進 Apps Script 的單一檔案
```

## 部署

### 1. Google Sheet

照 `docs/sheet-setup.md` 建立三個分頁與 `current` 公式。

### 2. Apps Script

1. 在 Sheet 選「擴充功能 → Apps Script」
2. 跑 `./tools/build-gas.sh`，把 `build/gas-bundle.gs` 全部貼進 `Code.gs`
3. 把 `SHEET_ID` 換成你的 Sheet ID
4. 部署 → 新增部署作業 → 網頁應用程式
   - 執行身分：**我**
   - 誰可以存取：**所有人**
5. 複製部署網址

改完程式碼後必須「管理部署作業 → 編輯 → 版本選新版本 → 部署」，
只按儲存不會生效，網址跑的仍是舊版。

### 3. 前端

把部署網址填進 `index.html` 的 `API_URL`，然後把整個目錄推上
GitHub Pages 或 Netlify。
