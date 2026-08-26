# Sheet 建置

Sheet ID: `1j3ZR5aMRWtVA2ILoydljTk1UjQ61qCn7KDPSqlOjha0`

試算表檔名是自由的（建議「比特幣預測賽 2026」），不影響程式。
但**分頁名稱不可更改**：`Code.gs` 用名字尋找分頁。

## 建立方式

新建空白試算表 → 擴充功能 → Apps Script → 貼上 `tools/bootstrap-sheet.gs`
→ 上方函式選單選 `setupSheet` → 執行 → 讀「執行記錄」。

腳本可重複執行：它會清空並重建三個分頁，不會累積髒資料。
它也會刪掉預設的「工作表1」，所以不必手動建分頁。

## 三個分頁

- `bets` — append-only 流水帳。欄序見 `src/lib.js` 的 `BET_COLS`，不可更動。
  `ts` / `player_id` / `name` / `src` / `nonce` 五欄強制為純文字格式。
- `players` — 身分表，PIN 只存 SHA-256 雜湊，不存明碼。
- `current` — 純公式頁。`B1` 填 9/11 開盤價，其餘自動。

## 兩個容易踩的地雷

**`ts` 欄必須是純文字。** 若讓 Sheets 自動判斷型別，ISO 8601 字串會被轉成 Date，
`src/lib.js` 的 `Date.parse(r[0])` 收到 Date 物件會回 `NaN`，
`hasRecentNonce` 的時間窗就整個失效，雙擊會寫進兩列。
腳本已用 `setNumberFormat('@')` 鎖死，不要手動改回自動格式。

**首注時間用 `XLOOKUP(..., search_mode=1)` 而非 `MINIFS`。**
`MINIFS` 只對數值有效，套在純文字的 `ts` 欄上會回 0。

## 關於 Sheet ID 的可見性

`SHEET_ID` 會寫進 `src/Code.gs`，而 `Code.gs` 在版控裡。
若日後把 repo 設為 public，這個 ID 就會公開。

實務上沒有風險：試算表本身不對外分享，所有讀寫都由 Apps Script
以擁有者身分進行，光有 ID 進不去。但別把試算表的共用權限改成
「知道連結的任何人」，那才會真的出事。
