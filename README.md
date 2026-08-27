# 比特幣開盤價預測賽

25 人的封閉賭局。押 **2026-09-11 00:00 (UTC+8) Coinbase Exchange BTC-USD 的開盤價**，賭一頓飯。

> **這個遊戲已經上線，而且有人下注了。** 改任何東西之前先讀〈現況〉。

---

## 現況（2026-08-27）

| | |
|---|---|
| 狀態 | 進行中，距結算 15 天 |
| 已下注 | 3 / 25（幸運好豪、Kevin、David）|
| 下注截止 | 2026-09-11 00:00 (UTC+8)，與結算同一瞬間 |
| Sheet | `1j3ZR5aMRWtVA2ILoydljTk1UjQ61qCn7KDPSqlOjha0` |
| Web App | `https://script.google.com/macros/s/AKfycbz96sNqUTzyxmVymm9G1R0TYAcYjYX2Vb5wxM-ZswwGAez3SVYdXQvs8i695XrRYODw/exec` |

### ⚠️ 交接時未完成的兩件事

**1. `bets` 與 `players` 各有一列 David 的測試髒資料要刪**

`ts` 是 `2026-08-27T09:08:01+08:00`、`player_id` 是 `david` 的那兩列。

`players` 那列尤其要刪——它用測試 PIN 把 David 註冊掉了，不刪的話**真正的 David 用自己的 PIN 下注會一直拿到「PIN 不對」而且無法自救**。

`bets` 開賽後原則上維持 append-only，但這是測試造成的髒資料，刪掉是對的。其他人的下注不要動。

**2. 前端還沒重新部署**

伺服器端已經接受 4–6 位 PIN，但線上的 `index.html` 若還是舊版，輸入框的 `maxlength="4"` 會讓人根本輸不進第 5 位。把 `index.html`、`src/`、`assets/` 重推一次。

---

## 計分

```
膽量   = abs(預測價 − 下注當下市價) / 下注當下市價 × 100
誤差   = abs(預測價 − 9/11 開盤價) / 9/11 開盤價 × 100
容許值 = round(6 × √剩餘天數)      ← 下注日距 9/11 的天數，至少 1
餐點倍數 = max(0, (1 + 膽量/10) × (1 − 誤差/容許值))
```

**越早下注，容許值越寬**——這就是早鳥機制。它不是給你更高的天花板，是給你更厚的安全網。

`容許值 = 6√天數` 剛好抵銷誤差隨時間的 √t 成長，所以「抄市價」的期望值每天都是平的 0.67；但有觀點的人越早下注期望值越高（同樣偏離 6%，8/26 是 0.95，9/10 只剩 0.27）。這是刻意設計的，不要動這條公式。

截止前可以隨時改注，**計分只看最新一筆**，但每次送出都會在 `bets` 留下永久紀錄。

---

## 架構

```
index.html      前端頁面（載入下面兩個模組）
src/lib.js      純函式：計分、名單、驗證、流水帳聚合。零 I/O
src/api.js      前端 API client
src/Code.gs     Apps Script：HTTP 進出、Sheet 讀寫、行情擷取
tools/build-gas.sh      把 lib.js + Code.gs 打包成單一 .gs
tools/bootstrap-sheet.gs 一鍵重建 Sheet 結構（見下方警告）
test/           Node 測試，零依賴
docs/sheet-setup.md     Sheet 結構、公式、兩個地雷
```

**`src/lib.js` 是樞紐**：它同時在 Node（測試）、Apps Script（伺服器）、瀏覽器（前端）三個地方執行。因此：

- 不可以用 `require` / `import` / 任何 Node 專屬 API
- 匯出只能寫在檔尾 `typeof module !== 'undefined'` 的保護區塊裡
- 必須維持零 I/O

**邏輯全部集中在 `lib.js`、`Code.gs` 只留 I/O，是刻意的。** Apps Script 沒辦法自動化測試，`lib.js` 可以。凡是能純函式化的都別留在 `Code.gs`。

---

## 開發

```bash
node --test
```

50 個測試，零依賴，不需要 `npm install`，沒有 `package.json`。

> **不要寫成 `node --test test/`。** Node 26 會把 `test` 當成模組去載入，報 `Cannot find module`。不帶參數即可，Node 會自己掃出 `test/**/*.test.js`。

本機預覽前端：

```bash
python3 -m http.server 8000
```

然後開 `http://localhost:8000/index.html`。**直接用 `file://` 開會讓 fetch 失敗**，一定要起伺服器。

---

## 部署

改完程式碼後，**伺服器與前端是兩套獨立的部署，通常兩邊都要做**。只做一半會出現「輸得進去但送不出來」或反過來的怪現象。

### 伺服器（Apps Script）

```bash
./tools/build-gas.sh
```

把 `build/gas-bundle.gs` 全部內容貼進 Apps Script 的 `Code.gs`，**取代全部原有內容**。

然後「**部署 → 管理部署作業 → 編輯（鉛筆）→ 版本選「新版本」→ 部署**」。

> **只按儲存不會生效**，網址跑的仍是舊版程式碼。這個坑會讓人 debug 很久。
>
> 走「編輯 → 新版本」網址不變；走「新增部署作業」會產生**新網址**，那就得同步更新 `index.html` 的 `API_URL` 和本文件。

### 前端

把 `index.html`、`src/`、`assets/` 推上 GitHub Pages 或 Netlify。沒有建置步驟。

> repo 若設為 public，`API_URL` 與 `SHEET_ID` 就會公開。實務上風險有限——Sheet 不對外分享，讀寫都由 Apps Script 以擁有者身分進行，寫入受 PIN 保護。但**密封性會消失**（任何人都能打 `doGet` 看到全場下注），開賽前要跟大家講明。

---

## 常見修改

### 改名單

名單只定義在 `src/lib.js` 的 `ROSTER`（25 人）。但它**同時存在於兩個部署裡**：瀏覽器的 `lib.js` 決定下拉選單，Apps Script 裡的同一份決定伺服器願不願意收。**改完兩邊都要重新部署**，只改一邊會出現「選得到但送不出去」。

新名字必須通過安全檢查：不以 `=` `+` `-` `@` `'` 開頭、不是純數字或日期／貨幣／百分比樣式、正規化後不與現有名字重複、不超過 20 字。`test/lib.test.js` 會把這些全部驗一次。

`test/lib.test.js` 裡寫死了「剛好 25 個」，人數變動要一併改。

**改某個人名字的寫法要特別小心。** `player_id` 是名字正規化來的，改寫法等於變成不同的人：舊的注會變成孤兒留在排行榜上、PIN 註冊卡在舊 id、新寫法從 `seq=1` 重來。已經下過注的人（目前是幸運好豪、Kevin、David）不要改寫法。

移除已下注的人，他的注**還是會顯示**——`rosterFromRows` 從 `bets` 讀，不看名單，而 `bets` 不能刪。他只是無法再下注。

### 改 PIN 規則

目前是 4–6 位數字，定義在 `src/lib.js` 的 `validateSubmission`。

下限守在 4 位是刻意的：端點公開，而且**猜對 PIN 就等於可以冒名下注**，猜對本身就是攻擊成功。1 位數只有 10 種組合，以目前每秒約一次的速度十秒就掃完，等於沒上鎖。

`pinHash_` 只是把字串丟進 SHA-256，對長度沒有假設，所以放寬長度不需要任何人重設 PIN。

### 重建 Sheet

跑 `tools/bootstrap-sheet.gs` 的 `setupSheet`。

> ⚠️ **它會清空並重建三個分頁。現在遊戲已經開始，跑下去會刪掉所有人的真實下注。** 只有在另外複製一份試算表做測試時才用它。

---

## 9/11 結算

1. 取 Coinbase Exchange BTC-USD **9/11 00:00 (UTC+8) 的開盤價**
2. 填進 `current!B1`
3. `倍數` 欄即為每人的餐點份數

結算價**刻意不自動抓**。結算只發生一次，值得親自確認那個數字，而不是讓腳本在半夜抓一個沒人核對過的價格就把 25 個人的飯錢算完。

總支出通常落在期望值 0.7–0.9 之間，25 人跑完大約發出 18–22 份，差額是主辦方的緩衝。若要帳剛好平，另外加一欄 `= 人數 × 個人倍數 ÷ 全體倍數總和`，但那會變成零和，每個人的成績會被同場對手影響。

---

## 前人踩過的坑

這些每一個都真的發生過，寫在這裡是為了不要再發生一次。

**Binance 不能用。** `api.binance.com` 對 Google 伺服器的 IP 回 **HTTP 451**（`data-api.binance.vision` 回 403）。Apps Script 跑在 Google 基礎架構上，所以 Binance 永久不可用，跟你人在哪裡無關。行情來源已全面改為 Coinbase Exchange，**不要改回去**。

**`curl` 測 `doPost` 不要加 `-X POST`。** 它會強制跟隨 302 之後也用 POST，而 Apps Script 導向的 `googleusercontent` 端點只收 GET，於是回 **405**——但**寫入其實已經成功了**，你只是讀不到回應，會誤以為要重試而寫進第二筆。正確寫法是只給 `-d`，讓 curl 自己推斷方法：

```bash
curl -sL "$URL" -H 'Content-Type: text/plain;charset=utf-8' -d '{...}'
```

**寫入測試不能用真實玩家的名字。** 名單是白名單，假名字一律被拒收，所以任何能通過驗證的寫入測試都必然用某個真人的身分——會在 `players` 把那個人用測試 PIN 註冊掉，本人之後無法自救。要測寫入就**另外複製一份試算表**，把 `SHEET_ID` 暫時指過去。

想在不寫入的前提下驗證伺服器行為，利用驗證順序（名字 → PIN → 預測價）：送一個合法的名字與 PIN 配上 `"bet": 0`，回傳 `bad_bet` 就代表前兩關過了，而且什麼都沒寫進去。

**`bets` 的 `ts` 欄必須是純文字格式。** 若讓 Sheets 自動判斷型別，ISO 8601 字串會被轉成 Date，`lib.js` 的 `Date.parse(r[0])` 收到 Date 物件會回 `NaN`，`hasRecentNonce` 的時間窗就整個失效，雙擊會寫進兩列。bootstrap 已用 `setNumberFormat('@')` 鎖死整欄，不要手動改回自動格式。

**Apps Script 專案裡所有 `.gs` 共用同一個全域作用域。** `tools/bootstrap-sheet.gs` 與 `src/lib.js` 都宣告了 `const SETTLE_MS`。貼 bundle 時要**取代**bootstrap，不能當成第二個檔案並存，否則重複宣告會讓整個專案壞掉，而且錯誤訊息不會指向真正的原因。

**底線結尾的函式在 Apps Script 裡是私有的**，不會出現在編輯器的執行下拉選單裡。寫臨時的診斷函式時名稱不要加底線，否則你選不到它。

**不要用啟發式規則消毒使用者輸入的名字。** Google Sheets 的 `USER_ENTERED` 解析器是 JavaScript `Number()` 的嚴格超集且與地區設定有關（它看得懂 `1,234`、`$5`、`50%`、`(7)`、`jan 5`、`12pm`），而且 `normalizeName` 的 NFKC 正規化會把全形 `＝` 轉成 ASCII `=`。這個猜謎遊戲我們輸了四輪才改用白名單。**白名單是資安機制，不只是功能**——能寫進儲存格的值必須是有限且事先驗證過安全的。

---

## 防作弊設計

`doPost` **只接受四個欄位**：`name`、`pin`、`bet`、`nonce`。

`ts`、`mkt`、`days_left`、`tol`、`guts`、`seq`、`src` **全部由伺服器產生**，前端送上來的同名值一律丟棄。

理由：膽量分 = `|預測價 − 市價| / 市價 × 100`。如果市價由前端提供，玩家開 DevTools 改一個數字就能宣稱自己在市價 108,000 時押了 115,000，膽量分瞬間翻倍。同理，下注時間若由前端聲稱，任何人都能假裝自己是早鳥。

`doPost` 用 `LockService` 序列化整段「讀取 → 計算 → 寫入」，並在放鎖前 `SpreadsheetApp.flush()`。少了這兩者之一，併發下兩個人會拿到同一個 `seq`，而 `rosterFromRows` 對 `seq` 沒有平手規則，會靜默吃掉其中一筆——注就這樣不見了。

公開端點的錯誤訊息一律收斂，詳情寫進 `console.error`（Apps Script 執行記錄，只有擁有者看得到）。玩家自己填錯的那幾種（PIN 格式、不在名單上、已截止）保留具體訊息，因為那描述的是他自己的問題，不是我們的內部結構。
