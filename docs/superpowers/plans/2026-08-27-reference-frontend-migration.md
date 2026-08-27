# 參考稿前端遷入現有後端 — 實作計畫

日期：2026-08-27
來源設計稿：`/Users/suweixiang/Downloads/WINNER WINNER CHICKEN DINNER/chicken-dinner.html`（1102 行）
目標檔案：`index.html`（目前 804 行）

## 目標

改用參考稿的前端（版面、區塊、互動），資料層換成現有的 Google Sheet 後端。
前端唯一要改寫的區塊是下注頁的「1. 這是誰」：員工編號自由輸入 → 25 人名單下拉 + PIN + 送出。

## 核心洞察

參考稿所有區塊的資料都來自 `state.bets` 一個地方：

```
renderHomeContent  → state.bets, state.livePrice, state.liveIsStale
drawScatterChart   → state.bets
computeAllResults  → state.bets
```

所以**把 `state.bets` 的來源從 localStorage 換成 `doGet`，大部分區塊一行都不用改**。
這是整個遷移的樞紐，也是把風險壓到最低的路徑。

## 資料層適配器（最關鍵的一段）

`doGet` 回傳的 roster 與參考稿的 bet 格式對接：

| 參考稿欄位 | 來源 | 註 |
|---|---|---|
| `name` | `roster[].name` | |
| `predict` | `roster[].bet` | |
| `marketAtBet` | `roster[].mkt` | |
| `dateStr` | 由 `roster[].ts` 推導成 `M/DD` | 僅供顯示 |
| `ts` | `Date.parse(roster[].ts)` | |
| `allowance` | **`roster[].tol`** | 見下方警告 |

> ⚠️ **容許值必須直接用伺服器的 `tol`，不可以用 `dateStr` 反推。**
>
> 參考稿的 `computeAllResults` 會拿 `dateStr` 去查 `ALLOWANCE_TABLE`。但下注日是
> 伺服器蓋的時間戳，反推會在時區與跨午夜的邊界對不上——玩家在 9/09 23:59 下注，
> 前端若用本地日期推成 9/10 就會少算一級容許值，排行榜與伺服器不一致。
>
> `computeAllResults` 要改成優先使用記錄裡既有的 `allowance`。

## 各任務

### Task A：骨架搬移與資料層

**交付：** 戰況頁完全可用，資料來自真實 Sheet。下注頁暫時停用（顯示「整理中」）。

- 以參考稿為基礎重寫 `index.html`，保留其 CSS、版面、區塊、`render()` 架構
- 載入 `src/lib.js` 與 `src/api.js`
- 刪除 `LS_KEYS`、`loadBets`/`saveBets`/`loadParticipants`/`saveParticipants`/
  `getAdminPass`/`setAdminPass`
- 新增 `betsFromRoster(roster)` 適配器，產出上表的格式
- `state.bets` 由 `api.getState()` 填入，30 秒輪詢 + `visibilitychange`
- `computeAllResults` 改為優先使用記錄的 `allowance`
- 刪除 `PATH` 與 `marketPriceOn()`
- 刪除管理頁（`renderAdminPage`、`state.showAdmin`、`state.adminUnlocked`、
  `DEFAULT_ADMIN_PASS`）——參考稿裡 `showAdmin` 沒有任何地方會設成 true，
  已經是死碼，拿掉零風險

**驗收：** 戰況頁顯示真實 roster；排行榜倍數與 `current` 分頁一致；無 console 錯誤。

### Task B：下注區與送出流程

**交付：** 可實際下注與改注。

- 「1. 這是誰」改為：名單下拉（`ROSTER`，第一項空白占位）+ PIN 輸入 + 送出按鈕
- 沿用目前 `index.html` 的欄位樣式（下拉與 PIN 等寬）
- PIN 提示文字逐字沿用：
  `首次下注請設定並記住 4 到 6 位數字 PIN 碼，若之後要改注需填入才能改注。`
- `onSubmitBet` 改為呼叫 `ChickenApi` 的 `placeBet()`
- **保留確認彈窗**（`showConfirmModal`），把「下注日」改成伺服器會蓋的日期，
  並在標題註明送出後仍可改注
- 送出後的處理沿用目前實作已驗證過的行為：
  - 每個失敗路徑都要恢復按鈕（`render()` 在 `S.mkt` 為 0 時會早期返回，
    所以按鈕狀態要在 `finally` 明確還原，不能只靠 `render()`）
  - 重送必須沿用暫存記錄裡的同一個 nonce
  - 名單下拉的 `change` 要更新「下注／改注」的按鈕文字
- 移除 `state.bet.name` 的員工編號邏輯

**驗收：** 用名單上的名字實際下注一次、改注一次，Sheet 出現兩列且 `seq` 遞增。

### Task C：行情來源與清理

**交付：** 可部署。

- `fetchLivePrice()` 打 Binance → 改用 `doGet` 的 `mkt`
  （伺服器算膽量用的就是它，前端預覽必須同源，否則玩家看到的倍數會與實際結果不同）
- `fetchWeekHistory()` 打 Binance → 改用 Coinbase Exchange candles，
  沿用目前 `loadKlines()` 已處理的兩個差異：時間單位是秒、排列為新到舊
- 全檔掃描確認沒有殘留：`PATH`、`localStorage`（下注相關）、`binance`、
  `員工編號`、`adminPass`、`showAdmin`
- 死引用檢查：每個 `getElementById` 都有對應元素
- `node --test` 維持 50 通過（不應動到被測檔案）
- 瀏覽器實測後 `./tools/deploy-pages.sh`

## 明確不做

- 管理頁的五個區塊（下注紀錄、參賽名單、主辦盈虧總覽、更改通關密語、展示工具）
  全部刪除。理由：Sheet 都有而且更完整；通關密語存在 localStorage 本來就不是真的防護；
  展示工具的「清空所有下注」在新架構下只會清掉 localStorage（那裡已無資料），
  給人清空了的錯覺而 Sheet 完全沒動——這是會誤導主辦的危險功能
- 名單搬進 Sheet（改名單仍需重新部署）
- 任何計分公式的改動——兩邊公式已驗證完全相同

## 已知的語意變化

`doGet` 只回傳每人最新一筆，不是完整送出歷程。因此任何「下注筆數」的顯示
都等於人數而非送出次數。完整歷程在 Sheet 的 `bets` 分頁，那才是它該在的地方。

## 不可破壞的約束

- 所有 `fetch` 走 `src/api.js`，不直接打 Web App
- `API_URL` 不變
- 計分呼叫 `src/lib.js` 的 `multOf` / `gutsOf`，不重寫公式
- 名字只能來自 `ROSTER`，伺服器不接受名單外的名字
- `localStorage` 僅用於自己的名字/PIN 與未送出的暫存，經由 `src/api.js`
- 行情來源維持 Coinbase Exchange（Binance 對 Google 伺服器 IP 回 451）
