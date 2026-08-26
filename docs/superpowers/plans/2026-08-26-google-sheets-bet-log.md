# Google Sheets 改注留檔 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓比特幣預測賽的玩家能在截止前隨時改注，每次送出都在 Google Sheets 留下永久紀錄，且下注時間與市價由伺服器蓋章而非前端聲稱。

**Architecture:** 三層。純函式庫 `src/lib.js` 承載所有計分與聚合邏輯，同時被 Node 測試與 Apps Script 使用；`src/Code.gs` 是薄薄的 Apps Script 層，只負責 Sheet 讀寫、行情擷取與 HTTP 進出；`index.html` 是靜態前端，透過 `src/api.js` 與 Web App 溝通。把邏輯全部推進 `lib.js` 是刻意的——Apps Script 難以自動化測試，所以凡是能純函式化的都不留在 `Code.gs`。

**Tech Stack:** Vanilla JS（無建置步驟）、Google Apps Script（V8 runtime）、Google Sheets、Node.js 內建 `node --test`（零依賴）、Coinbase Exchange 公開 REST API。

## Global Constraints

- 計分公式不得更動：`餐點倍數 = max(0, (1 + 膽量/10) × (1 − 誤差/容許值))`
- `容許值 = round(6 × √剩餘天數)`，`剩餘天數 = max(1, ceil((SETTLE − ts) / 86400000))`
- `膽量 = abs(bet − mkt) / mkt × 100`，`誤差 = abs(bet − settle) / settle × 100`
- `SETTLE = 2026-09-11T00:00:00+08:00`，下注截止同一瞬間
- 結算價定義：Coinbase Exchange BTC-USD，2026-09-11 00:00 (UTC+8) 開盤價
- 行情來源不可改回 Binance：它對 Google 伺服器 IP 回 HTTP 451，Apps Script 用不了
- 玩家名字是白名單（`src/lib.js` 的 `ROSTER`，25 人），不是自由輸入。
  這是資安機制而非功能：四輪審查證明啟發式消毒擋不住 Sheets 的 USER_ENTERED 解析器
- `ts`、`days_left`、`tol`、`mkt` 一律由伺服器產生，前端送來的同名值直接丟棄
- `bets` 分頁 append-only，只新增不修改、不刪除
- 網頁只顯示每人最新一筆，改注歷程只存在於 Sheet
- POST 一律用 `Content-Type: text/plain;charset=utf-8`（Apps Script 無法回應 CORS preflight）
- `src/lib.js` 必須同時能在 Node 與 Apps Script 執行：不得使用 `require`、`import`、Node 專屬 API，匯出只能寫在檔尾的 `typeof module !== 'undefined'` 保護區塊內
- 提交訊息用中文正文；每個 Task 結束時提交

---

## File Structure

| 檔案 | 職責 |
|---|---|
| `src/lib.js` | 純函式：時間換算、容許值、膽量、倍數、名字正規化、bets 列聚合。無任何 I/O。Node 與 GAS 共用 |
| `src/Code.gs` | Apps Script：`doGet` / `doPost`、Sheet 讀寫、行情擷取、PIN 雜湊、鎖。只做 I/O 與組裝 |
| `src/api.js` | 前端 API client：GET/POST 封裝、離線暫存、nonce、身分記憶。fetch 與 storage 由外部注入以便測試 |
| `index.html` | 頁面：DOM 與 SVG 渲染、下注與改注互動。載入 `lib.js` 與 `api.js` |
| `test/lib.test.js` | `src/lib.js` 的單元測試 |
| `test/api.test.js` | `src/api.js` 的單元測試（stub fetch / stub storage） |
| `tools/build-gas.sh` | 把 `lib.js` + `Code.gs` 串成單一檔案供貼進 Apps Script，避免兩邊手動同步而漂移 |
| `docs/sheet-setup.md` | `current` 分頁的公式清單與手動驗證步驟 |
| `README.md` | 部署步驟 |

`src/lib.js` 被 Node、Apps Script、瀏覽器三邊共用，這是整個結構的樞紐。它不得有任何 I/O。

---

### Task 1: lib.js 時間與計分核心

這是全案風險最高的一段。規格特別點名跨午夜的 `ceil` / `floor` 差一天會讓整個容許值歪掉，所以先用測試把邊界釘死。

**Files:**
- Create: `src/lib.js`
- Create: `test/lib.test.js`
- Create: `.gitignore`（追加 `build/` 與 `node_modules/`）

**Interfaces:**
- Consumes: 無（本案第一個任務）
- Produces:
  - `SETTLE_MS: number` — `2026-09-11T00:00:00+08:00` 的毫秒值
  - `MS_PER_DAY: number` — `86400000`
  - `normalizeName(name: string) => string`
  - `daysLeftFrom(tsMs: number, settleMs?: number) => number`
  - `tolFor(daysLeft: number) => number`
  - `gutsOf(bet: number, mkt: number) => number`
  - `multOf(bet: number, mkt: number, settle: number, tol: number) => number`
  - `isClosed(nowMs: number, settleMs?: number) => boolean`

- [ ] **Step 1: 寫失敗的測試**

建立 `test/lib.test.js`：

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const lib = require('../src/lib.js');

const at = (iso) => Date.parse(iso);

test('SETTLE_MS 指向 2026-09-11 00:00 UTC+8', () => {
  assert.strictEqual(lib.SETTLE_MS, at('2026-09-11T00:00:00+08:00'));
});

test('daysLeftFrom 對得上原本的 DL 表', () => {
  assert.strictEqual(lib.daysLeftFrom(at('2026-08-26T14:03:11+08:00')), 16);
  assert.strictEqual(lib.daysLeftFrom(at('2026-08-31T09:00:00+08:00')), 11);
  assert.strictEqual(lib.daysLeftFrom(at('2026-09-05T23:00:00+08:00')), 6);
});

test('daysLeftFrom 跨午夜必須換一級', () => {
  assert.strictEqual(lib.daysLeftFrom(at('2026-09-09T23:59:00+08:00')), 2);
  assert.strictEqual(lib.daysLeftFrom(at('2026-09-10T00:01:00+08:00')), 1);
});

test('daysLeftFrom 下限是 1，不會給 0 或負數', () => {
  assert.strictEqual(lib.daysLeftFrom(at('2026-09-10T23:59:59+08:00')), 1);
  assert.strictEqual(lib.daysLeftFrom(at('2026-09-11T00:00:00+08:00')), 1);
  assert.strictEqual(lib.daysLeftFrom(at('2026-09-12T00:00:00+08:00')), 1);
});

test('tolFor 對得上公告的容許值表', () => {
  assert.strictEqual(lib.tolFor(16), 24);
  assert.strictEqual(lib.tolFor(11), 20);
  assert.strictEqual(lib.tolFor(6), 15);
  assert.strictEqual(lib.tolFor(3), 10);
  assert.strictEqual(lib.tolFor(2), 8);
  assert.strictEqual(lib.tolFor(1), 6);
});

test('gutsOf 是相對市價的百分比，方向不影響大小', () => {
  assert.ok(Math.abs(lib.gutsOf(85000, 78000) - 8.9743589) < 1e-6);
  assert.strictEqual(lib.gutsOf(78000, 78000), 0);
  assert.strictEqual(lib.gutsOf(70000, 80000), lib.gutsOf(90000, 80000));
});

test('multOf 重現規格中的六位範例玩家', () => {
  const r = (x) => Math.round(x * 100) / 100;
  assert.strictEqual(r(lib.multOf(108000, 108000, 115000, 25)), 0.76); // A 抄市價
  assert.strictEqual(r(lib.multOf(114500, 108000, 115000, 25)), 1.57); // B 早+敢+中
  assert.strictEqual(r(lib.multOf(103000, 110000, 115000, 19)), 0.74); // C 早但看反
  assert.strictEqual(r(lib.multOf(116000, 112000, 115000, 15)), 1.28); // D 中膽很準
  assert.strictEqual(r(lib.multOf(114800, 114500, 115000, 6)), 1.00);  // E 晚+保守+準
  assert.strictEqual(r(lib.multOf(110000, 114500, 115000, 6)), 0.38);  // F 晚+亂衝
});

test('multOf 誤差超過容許值時歸零，不會變負數', () => {
  assert.strictEqual(lib.multOf(80000, 78000, 115000, 6), 0);
});

test('normalizeName 讓全形、大小寫、多餘空白指向同一個人', () => {
  assert.strictEqual(lib.normalizeName('  阿明  '), '阿明');
  assert.strictEqual(lib.normalizeName('Ｋｅｖｉｎ'), 'kevin');
  assert.strictEqual(lib.normalizeName('KEVIN'), lib.normalizeName('kevin'));
  assert.strictEqual(lib.normalizeName('大  雄'), '大 雄');
});

test('isClosed 在截止瞬間就成立', () => {
  assert.strictEqual(lib.isClosed(at('2026-09-10T23:59:59+08:00')), false);
  assert.strictEqual(lib.isClosed(at('2026-09-11T00:00:00+08:00')), true);
});
```

- [ ] **Step 2: 跑測試確認它失敗**

```bash
node --test
```

預期：全部 fail，錯誤訊息為 `Cannot find module '../src/lib.js'`。

- [ ] **Step 3: 寫最小實作**

建立 `src/lib.js`：

```js
'use strict';

// 結算＝下注截止，同一瞬間
const SETTLE_MS = Date.parse('2026-09-11T00:00:00+08:00');
const MS_PER_DAY = 86400000;

// 名字正規化：NFKC 讓全形轉半形，再去空白、收斂內部空白、英文轉小寫。
// 目的是讓「Ｋｅｖｉｎ」「KEVIN」「 kevin 」指向同一個 player_id。
function normalizeName(name) {
  return String(name).normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

// 剩餘天數，下限 1。用 ceil 而非 floor：9/09 23:59 下注仍算 2 天，
// 一過午夜掉到 1 天，容許值從 8 掉到 6。
function daysLeftFrom(tsMs, settleMs) {
  const s = (settleMs === undefined) ? SETTLE_MS : settleMs;
  return Math.max(1, Math.ceil((s - tsMs) / MS_PER_DAY));
}

function tolFor(daysLeft) {
  return Math.round(6 * Math.sqrt(daysLeft));
}

function gutsOf(bet, mkt) {
  return Math.abs(bet - mkt) / mkt * 100;
}

function multOf(bet, mkt, settle, tol) {
  const g = gutsOf(bet, mkt);
  const e = Math.abs(bet - settle) / settle * 100;
  return Math.max(0, (1 + g / 10) * (1 - e / tol));
}

function isClosed(nowMs, settleMs) {
  const s = (settleMs === undefined) ? SETTLE_MS : settleMs;
  return nowMs >= s;
}

// 檔尾匯出。Apps Script 沒有 module，typeof 檢查讓這段在 GAS 被安靜略過。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SETTLE_MS, MS_PER_DAY,
    normalizeName, daysLeftFrom, tolFor, gutsOf, multOf, isClosed
  };
}
```

- [ ] **Step 4: 跑測試確認通過**

```bash
node --test
```

預期：`# pass 10` / `# fail 0`。

若 `multOf` 那題失敗，先印出實際值再對規格 §3 的表格核對，不要改測試去遷就實作。

- [ ] **Step 5: 更新 .gitignore 並提交**

`.gitignore` 追加兩行：

```
build/
node_modules/
```

```bash
git add .gitignore src/lib.js test/lib.test.js
git commit -m "新增計分核心純函式與邊界測試

容許值、剩餘天數、膽量、倍數、名字正規化全部集中在 src/lib.js，
不含任何 I/O，供 Node 測試與 Apps Script 共用。

測試釘死兩個最容易寫錯的地方：跨午夜的剩餘天數換級，
以及誤差超過容許值時倍數必須歸零而非變負。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: lib.js 的 bets 列聚合

`bets` 是 append-only 流水帳，同一個人會有多列。這個任務負責「從流水帳算出每人最新一筆」，以及寫入前需要的序號與冪等檢查。全部是純函式，測試不需要碰 Sheet。

**Files:**
- Modify: `src/lib.js`（在匯出區塊之前追加）
- Modify: `test/lib.test.js`（在檔尾追加）

**Interfaces:**
- Consumes: Task 1 的 `src/lib.js`
- Produces:
  - `BET_COLS: string[]` — `['ts','player_id','name','seq','days_left','tol','mkt','bet','guts','src','nonce']`，即 `bets` 分頁的欄序
  - `rowToBet(row: any[]) => object`
  - `rosterFromRows(rows: any[][]) => Array<{name,bet,mkt,tol,guts,ts}>`
  - `nextSeq(rows: any[][], playerId: string) => number`
  - `hasRecentNonce(rows: any[][], nonce: string, nowMs: number, windowMs?: number) => boolean`

- [ ] **Step 1: 寫失敗的測試**

在 `test/lib.test.js` 檔尾追加：

```js
// --- bets 列聚合 ---
// 欄序：ts, player_id, name, seq, days_left, tol, mkt, bet, guts, src, nonce
const row = (ts, pid, name, seq, dl, tol, mkt, bet, guts, nonce) =>
  [ts, pid, name, seq, dl, tol, mkt, bet, guts, 'live', nonce];

const SAMPLE = [
  row('2026-08-26T14:03:11+08:00', '阿明', '阿明', 1, 16, 24, 78412, 85000, 8.40, 'n1'),
  row('2026-08-27T10:00:00+08:00', '小美', '小美', 1, 15, 23, 79200, 78000, 1.52, 'n2'),
  row('2026-09-02T21:47:05+08:00', '阿明', '阿明', 2, 9, 18, 79615, 82000, 2.99, 'n3'),
];

test('rosterFromRows 每人只留 seq 最大的那筆', () => {
  const r = lib.rosterFromRows(SAMPLE);
  assert.strictEqual(r.length, 2);
  const ming = r.find((x) => x.name === '阿明');
  assert.strictEqual(ming.bet, 82000);
  assert.strictEqual(ming.tol, 18);
  assert.strictEqual(ming.ts, '2026-09-02T21:47:05+08:00');
});

test('rosterFromRows 即使列順序被打亂也取得到最新一筆', () => {
  const shuffled = [SAMPLE[2], SAMPLE[0], SAMPLE[1]];
  const ming = lib.rosterFromRows(shuffled).find((x) => x.name === '阿明');
  assert.strictEqual(ming.bet, 82000);
});

test('rosterFromRows 忽略空白列，且不外洩 nonce', () => {
  const r = lib.rosterFromRows(SAMPLE.concat([['', '', '', '', '', '', '', '', '', '', '']]));
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].nonce, undefined);
});

test('rosterFromRows 把數字欄轉成 number', () => {
  const asText = [row('2026-08-26T14:03:11+08:00', '阿明', '阿明', '1', '16', '24', '78412', '85000', '8.40', 'n1')];
  const r = lib.rosterFromRows(asText);
  assert.strictEqual(r[0].bet, 85000);
  assert.strictEqual(typeof r[0].tol, 'number');
});

test('nextSeq 接續該玩家的序號，新玩家從 1 開始', () => {
  assert.strictEqual(lib.nextSeq(SAMPLE, '阿明'), 3);
  assert.strictEqual(lib.nextSeq(SAMPLE, '小美'), 2);
  assert.strictEqual(lib.nextSeq(SAMPLE, '大雄'), 1);
  assert.strictEqual(lib.nextSeq([], '阿明'), 1);
});

test('hasRecentNonce 在時間窗內認得重複，窗外不認', () => {
  const now = Date.parse('2026-09-02T21:47:35+08:00'); // 距最後一列 30 秒
  assert.strictEqual(lib.hasRecentNonce(SAMPLE, 'n3', now), true);
  assert.strictEqual(lib.hasRecentNonce(SAMPLE, 'n9', now), false);
  const later = Date.parse('2026-09-02T21:49:05+08:00'); // 距最後一列 120 秒
  assert.strictEqual(lib.hasRecentNonce(SAMPLE, 'n3', later), false);
});
```

- [ ] **Step 2: 跑測試確認它失敗**

```bash
node --test
```

預期：新增的 6 題 fail，訊息為 `lib.rosterFromRows is not a function` 等。Task 1 的 10 題仍應 pass。

- [ ] **Step 3: 寫最小實作**

在 `src/lib.js` 的 `if (typeof module !== 'undefined')` 區塊**之前**插入：

```js
// bets 分頁的欄序。Code.gs 讀寫、rowToBet 解析都以此為準。
const BET_COLS = ['ts', 'player_id', 'name', 'seq', 'days_left',
                  'tol', 'mkt', 'bet', 'guts', 'src', 'nonce'];

function rowToBet(row) {
  const o = {};
  for (let i = 0; i < BET_COLS.length; i++) o[BET_COLS[i]] = row[i];
  return o;
}

// 每人只留 seq 最大的那筆。不依賴列順序，因為 Sheet 有可能被手動排序過。
function rosterFromRows(rows) {
  const byPlayer = {};
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r[1] === '' || r[1] == null) continue;
    const b = rowToBet(r);
    const prev = byPlayer[b.player_id];
    if (!prev || Number(b.seq) > Number(prev.seq)) byPlayer[b.player_id] = b;
  }
  return Object.keys(byPlayer).map((k) => {
    const b = byPlayer[k];
    // 只挑前端需要的欄位。nonce 與 player_id 不外流。
    return {
      name: b.name,
      bet: Number(b.bet),
      mkt: Number(b.mkt),
      tol: Number(b.tol),
      guts: Number(b.guts),
      ts: b.ts
    };
  });
}

function nextSeq(rows, playerId) {
  let max = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r && r[1] === playerId) max = Math.max(max, Number(r[3]) || 0);
  }
  return max + 1;
}

// 冪等檢查：雙擊或網路重試會用同一個 nonce 送兩次，只能寫一列。
// 由尾端往回掃，一旦看到超出時間窗的列就停，不必掃完整張表。
function hasRecentNonce(rows, nonce, nowMs, windowMs) {
  const w = (windowMs === undefined) ? 60000 : windowMs;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (!r) continue;
    const t = Date.parse(r[0]);
    if (!isNaN(t) && nowMs - t > w) break;
    if (r[10] === nonce) return true;
  }
  return false;
}
```

同時把匯出區塊改成：

```js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SETTLE_MS, MS_PER_DAY, BET_COLS,
    normalizeName, daysLeftFrom, tolFor, gutsOf, multOf, isClosed,
    rowToBet, rosterFromRows, nextSeq, hasRecentNonce
  };
}
```

- [ ] **Step 4: 跑測試確認通過**

```bash
node --test
```

預期：`# pass 16` / `# fail 0`。

- [ ] **Step 5: 提交**

```bash
git add src/lib.js test/lib.test.js
git commit -m "新增 bets 流水帳的聚合純函式

rosterFromRows 從 append-only 的流水帳取出每人 seq 最大的一筆，
刻意不依賴列順序，因為 Sheet 有可能被手動排序過。
回傳值只挑前端需要的欄位，nonce 與 player_id 不外流。

hasRecentNonce 由尾端往回掃並在超出時間窗時提早停止，
避免每次下注都掃完整張表。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: 建立 Google Sheet 與 current 公式

**由專案負責人本人執行**——subagent 沒有 Google 帳號，做不到這一步。

原本這個任務是一連串手動點選。改為一支可重複執行的 bootstrap 腳本：欄序與公式
不可能打錯，腳本進版控，日後要重建或開第二場再跑一次就好。

**Files:**
- Create: `tools/bootstrap-sheet.gs`
- Create: `docs/sheet-setup.md`

**Interfaces:**
- Consumes: Task 2 的 `BET_COLS` 欄序
- Produces: 一份含 `bets` / `players` / `current` 三個分頁的 Google Sheet；
  其 Sheet ID 供 Task 4 的 `SHEET_ID` 使用

- [ ] **Step 1: 跑 bootstrap 腳本**

1. 新建一份空白 Google 試算表，命名為「比特幣預測賽 2026」
2. 選「擴充功能 → Apps Script」
3. 把 `tools/bootstrap-sheet.gs` 整個貼進 `Code.gs`，取代全部原有內容
4. 上方函式選單選 `setupSheet`，按「執行」。首次執行會跳出授權視窗，允許存取試算表
5. 打開「執行記錄」

腳本會建好三個分頁、寫入表頭、灌入驗證用假資料、把九條公式填到第 55 列，
然後印出 Sheet ID 與一份逐項驗證報告。

- [ ] **Step 2: 讀執行記錄的驗證結果**

每一行以 `✓` 或 `✗` 開頭，格式為「實際值 / 預期值」。預期值不是手寫的常數，
而是腳本用與 `src/lib.js` 相同的公式在 JS 端獨立算出來的——兩邊同時錯成同一個
數字的機率極低，所以這是有意義的交叉驗證，不是自我背書。

應該看到 12 行 `✓`（阿明與小美各六項）與結尾的「全部驗證通過」。

`✗` 最可能的原因：

| 症狀 | 原因 |
|---|---|
| 最新預測是 85000 而非 82000 | `XLOOKUP` 的 `search_mode` 參數沒吃到 `-1` |
| 改注次數多 1 | `COUNTIF` 忘了減 1 |
| 膽量或倍數整欄空白 | 這份試算表的地區設定讓公式分隔符變成分號 |

出現任何 `✗` 就把整份執行記錄貼出來，不要自行修改公式。

- [ ] **Step 3: 記下 Sheet ID 並寫成文件**

從執行記錄取出 Sheet ID（也可從網址列 `/spreadsheets/d/` 與 `/edit` 之間取得）。

建立 `docs/sheet-setup.md`：

```markdown
# Sheet 建置

Sheet ID: `<貼上你的 Sheet ID>`

## 建立方式

新建空白試算表 → 擴充功能 → Apps Script → 貼上 `tools/bootstrap-sheet.gs`
→ 執行 `setupSheet` → 讀執行記錄。

腳本可重複執行：它會清空並重建三個分頁，不會累積髒資料。

## 三個分頁

- `bets` — append-only 流水帳。欄序見 `src/lib.js` 的 `BET_COLS`，不可更動。
  `ts` / `player_id` / `name` / `src` / `nonce` 五欄強制為純文字格式。
- `players` — 身分表，PIN 只存 SHA-256 雜湊。
- `current` — 純公式頁。`B1` 填 9/11 開盤價，其餘自動。

## 兩個容易踩的地雷

`ts` 欄必須是純文字。若讓 Sheets 自動判斷型別，ISO 8601 字串會被轉成 Date，
`src/lib.js` 的 `Date.parse(r[0])` 收到 Date 物件會回 `NaN`，
`hasRecentNonce` 的時間窗就整個失效。腳本已用 `setNumberFormat('@')` 鎖死。

首注時間用 `XLOOKUP(..., search_mode=1)` 而非 `MINIFS`。
`MINIFS` 只對數值有效，套在純文字的 `ts` 欄上會回 0。
```

- [ ] **Step 4: 提交**

```bash
git add tools/bootstrap-sheet.gs docs/sheet-setup.md
git commit -m "新增 Sheet 一鍵建置腳本

原本的手動點選步驟改為可重複執行的腳本:欄序與公式不可能打錯,
腳本進版控,日後重建或開第二場再跑一次即可。

假資料只給事實欄位,guts / days_left / tol 一律由腳本算出來,
避免手寫的衍生值與事實欄位對不起來——原本手寫的 guts 就是錯的。

ts 等五欄用 setNumberFormat('@') 鎖成純文字。若讓 Sheets 自動判斷型別,
ISO 8601 字串會被轉成 Date,lib.js 的 Date.parse 會回 NaN,
hasRecentNonce 的時間窗會整個失效。

首注時間改用 XLOOKUP 的正向搜尋而非 MINIFS——MINIFS 只對數值有效,
套在純文字的 ts 欄上會回 0。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: 打包腳本、Sheet 存取層、市價擷取

`src/lib.js` 與 `src/Code.gs` 是兩個檔，但 Apps Script 專案裡貼一個檔最不容易出錯，所以先做打包腳本，之後每次改完程式碼都用它產生單一檔案。市價擷取排在最前面，因為 `doGet` 與 `doPost` 都依賴它。

**Files:**
- Create: `tools/build-gas.sh`
- Create: `src/Code.gs`
- Modify: `src/lib.js`
- Modify: `test/lib.test.js`

**Interfaces:**
- Consumes: Task 2 的 `BET_COLS`、`rosterFromRows`；Task 3 的 Sheet ID
- Produces:
  - `parseTickerPrice(text: string) => number`（`lib.js`，純函式）
  - `sheet_(name: string) => Sheet`（`Code.gs`）
  - `betRows_() => any[][]`（`Code.gs`，已去表頭）
  - `json_(obj: object) => TextOutput`（`Code.gs`）
  - `nowIso_(d: Date) => string`（`Code.gs`，UTC+8 的 ISO 8601）
  - `fetchMarketPrice_() => { price: number, src: 'live' | 'fallback' }`（`Code.gs`）

- [ ] **Step 1: 寫 parseTickerPrice 的失敗測試**

在 `test/lib.test.js` 檔尾追加：

```js
// --- 行情 API 回應解析 ---
test('parseTickerPrice 取出價格並轉成 number', () => {
  assert.strictEqual(
    lib.parseTickerPrice('{"symbol":"BTCUSDT","price":"78412.50000000"}'),
    78412.5
  );
});

test('parseTickerPrice 對壞掉的回應要丟例外而不是回 NaN', () => {
  assert.throws(() => lib.parseTickerPrice('{"symbol":"BTCUSDT"}'));
  assert.throws(() => lib.parseTickerPrice('{"price":"0"}'));
  assert.throws(() => lib.parseTickerPrice('{"price":"-5"}'));
  assert.throws(() => lib.parseTickerPrice('<html>429 Too Many Requests</html>'));
});
```

最後一題是關鍵：行情 API 被限流或地區封鎖時回的是 HTML 不是 JSON，必須丟例外才能觸發 fallback，回 `NaN` 會讓壞價格寫進 Sheet。

- [ ] **Step 2: 跑測試確認它失敗**

```bash
node --test
```

預期：新增的 2 題 fail，訊息為 `lib.parseTickerPrice is not a function`。

- [ ] **Step 3: 實作 parseTickerPrice**

在 `src/lib.js` 的匯出區塊之前插入：

```js
// 行情 API 回應解析。預期 ticker 回應有頂層 price 欄位。被限流或地區封鎖時回的是 HTML 而非 JSON，
// 因此必須丟例外讓上層走 fallback，絕不能回 NaN。
function parseTickerPrice(text) {
  const o = JSON.parse(text);
  const p = Number(o.price);
  if (!isFinite(p) || p <= 0) throw new Error('行情回應沒有可用的價格：' + text.slice(0, 120));
  return p;
}
```

匯出區塊追加 `parseTickerPrice`：

```js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SETTLE_MS, MS_PER_DAY, BET_COLS,
    normalizeName, daysLeftFrom, tolFor, gutsOf, multOf, isClosed,
    rowToBet, rosterFromRows, nextSeq, hasRecentNonce,
    parseTickerPrice
  };
}
```

- [ ] **Step 4: 跑測試確認通過**

```bash
node --test
```

預期：`# pass 18` / `# fail 0`。

- [ ] **Step 5: 寫打包腳本**

建立 `tools/build-gas.sh`：

```bash
#!/usr/bin/env bash
# 把 src/lib.js 與 src/Code.gs 串成單一檔案，供貼進 Apps Script 專案。
# 兩個檔分開維護但只貼一個，避免兩邊手動同步而漂移。
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build
{
  echo "// ====== 自動產生，請勿直接編輯這個檔 ======"
  echo "// 來源：src/lib.js + src/Code.gs"
  echo "// 產生時間：$(date '+%Y-%m-%d %H:%M:%S')"
  echo
  cat src/lib.js
  echo
  cat src/Code.gs
} > build/gas-bundle.gs
echo "已產生 build/gas-bundle.gs（$(wc -l < build/gas-bundle.gs | tr -d ' ') 行）"
echo
echo "接下來："
echo "  1. 全選 build/gas-bundle.gs 的內容"
echo "  2. 貼進 Apps Script 專案的 Code.gs，取代全部原有內容"
echo "  3. 部署 → 管理部署作業 → 編輯（鉛筆）→ 版本選「新版本」→ 部署"
echo "     ※ 只按儲存不會生效，網址跑的仍是舊版程式碼"
```

加上執行權限：

```bash
chmod +x tools/build-gas.sh
```

- [ ] **Step 6: 寫 Code.gs 的存取層與市價擷取**

建立 `src/Code.gs`：

```js
// ====== Apps Script 層：只做 I/O 與組裝，邏輯一律放 lib.js ======

const SHEET_ID = 'PUT_YOUR_SHEET_ID_HERE';  // ← 換成 docs/sheet-setup.md 裡記的 ID
const TZ = 'Asia/Taipei';
// Coinbase Exchange ticker。Binance 已被廢棄：api.binance.com 與 data-api.binance.vision
// 對 Google 伺服器 IP 回應 HTTP 451 或 403，故 Apps Script 無法使用。
const TICKER_URL = 'https://api.exchange.coinbase.com/products/BTC-USD/ticker';

function sheet_(name) {
  const sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName(name);
  if (!sh) throw new Error('找不到分頁：' + name);
  return sh;
}

// 讀 bets 全部資料列（已去表頭）。空表回空陣列。
function betRows_() {
  const sh = sheet_('bets');
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, BET_COLS.length).getValues();
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function nowIso_(d) {
  return Utilities.formatDate(d, TZ, "yyyy-MM-dd'T'HH:mm:ssXXX");
}

// 市價擷取。快取 30 秒，避免每次點擊都打一次行情 API。
// 抓不到時退回 bets 最後一列的市價，並標記 src=fallback 讓事後看得出來。
function fetchMarketPrice_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('mkt');
  if (hit) return { price: Number(hit), src: 'live' };

  try {
    const res = UrlFetchApp.fetch(TICKER_URL, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw new Error('HTTP ' + res.getResponseCode());
    const p = parseTickerPrice(res.getContentText());
    cache.put('mkt', String(p), 30);
    return { price: p, src: 'live' };
  } catch (err) {
    const rows = betRows_();
    for (let i = rows.length - 1; i >= 0; i--) {
      const p = Number(rows[i][6]);
      if (isFinite(p) && p > 0) return { price: p, src: 'fallback' };
    }
    throw new Error('無法取得市價，且 bets 沒有任何可用的歷史市價：' + err.message);
  }
}
```

- [ ] **Step 7: 打包並部署到 Apps Script**

```bash
./tools/build-gas.sh
```

在 Google Sheet 中選「擴充功能 → Apps Script」開啟繫結的專案。

此時 `Code.gs` 裡是 Task 3 的 bootstrap 腳本。**全選並刪掉，再貼上 `build/gas-bundle.gs`
的全部內容。**

⚠️ **絕對不要保留 bootstrap 當成第二個檔案。** Apps Script 專案裡所有 `.gs` 檔共用
同一個全域作用域，而 `tools/bootstrap-sheet.gs` 與 `src/lib.js` 都宣告了
`const SETTLE_MS`。兩個檔案並存會造成重複宣告，整個專案立刻壞掉，
而且錯誤訊息不會指向真正的原因。

bootstrap 的任務已經結束，日後若要重建 Sheet，把 `tools/bootstrap-sheet.gs`
重新貼回來執行一次，跑完再換回 bundle 即可。

`SHEET_ID` 已經填好實際值，不需要再修改。存檔。

- [ ] **Step 8: 在 Apps Script 編輯器手動驗證市價擷取**

在編輯器上方的函式下拉選單選 `checkPrice`，按「執行」。（`fetchMarketPrice_` 因結尾有底線而不會出現在選單裡。）首次執行會跳出授權視窗，允許存取試算表與外部服務。

執行後開「執行記錄」，應無錯誤。為了看到回傳值，暫時在編輯器貼上並執行這個檢查函式：

```js
// 函式名稱結尾不可加底線。Apps Script 把底線結尾的函式視為私有,
// 它們不會出現在編輯器的執行下拉選單裡,你會選不到而誤執行別的函式。
function checkPrice() {
  const r = fetchMarketPrice_();
  Logger.log('price=%s src=%s', r.price, r.src);
  Logger.log('betRows 筆數=%s', betRows_().length);
}
```

預期記錄類似：

```
price=78412.5 src=live
betRows 筆數=3
```

`src` 若是 `fallback`，代表行情 API 打不通——確認不是 Sheet ID 填錯，再看是否為地區封鎖。`betRows 筆數` 應為 3，即 Task 3 灌的假資料；若為 0 代表 Sheet ID 指錯了試算表。

驗證完把 `checkPrice` 從編輯器刪掉，它不進版控。

- [ ] **Step 9: 提交**

```bash
git add tools/build-gas.sh src/Code.gs src/lib.js test/lib.test.js
git commit -m "新增打包腳本、Sheet 存取層與市價擷取

parseTickerPrice 放在 lib.js 並要求對壞回應丟例外——行情 API 被限流或
地區封鎖時回的是 HTML 而非 JSON，回 NaN 會讓壞價格寫進 Sheet。

市價快取 30 秒，抓不到時退回 bets 最後一列並標記 src=fallback，
事後在 Sheet 裡看得出哪幾筆的市價不是現抓的。

build-gas.sh 把 lib.js 與 Code.gs 串成單一檔案，
避免兩邊手動同步而漂移。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: doGet 與 Web App 部署

**Files:**
- Modify: `src/Code.gs`
- Create: `README.md`

**Interfaces:**
- Consumes: Task 4 的 `fetchMarketPrice_`、`betRows_`、`json_`、`nowIso_`；Task 1 的 `daysLeftFrom`、`tolFor`、`isClosed`；Task 2 的 `rosterFromRows`
- Produces:
  - `doGet() => TextOutput`，JSON 結構：
    `{ ok: true, serverTime: string, mkt: number, src: string, daysLeft: number, tol: number, closed: boolean, roster: Array<{name,bet,mkt,tol,guts,ts}> }`
  - Web App 部署網址，供 Task 7 的 `API_URL` 使用

- [ ] **Step 1: 實作 doGet**

在 `src/Code.gs` 檔尾追加：

```js
// ====== HTTP 進入點 ======

function doGet() {
  try {
    const now = new Date();
    const nowMs = now.getTime();
    const priced = fetchMarketPrice_();
    const dl = daysLeftFrom(nowMs);
    return json_({
      ok: true,
      serverTime: nowIso_(now),
      mkt: priced.price,
      src: priced.src,
      daysLeft: dl,
      tol: tolFor(dl),
      closed: isClosed(nowMs),
      roster: rosterFromRows(betRows_())
    });
  } catch (err) {
    return json_({ ok: false, reason: 'server_error', message: String(err) });
  }
}
```

- [ ] **Step 2: 打包並部署**

```bash
./tools/build-gas.sh
```

貼進 Apps Script 的 `Code.gs`（記得 `SHEET_ID` 那行要保留你填好的值）。接著「部署 → 新增部署作業 → 類型選『網頁應用程式』」，設定：

- 執行身分：**我**
- 誰可以存取：**所有人**

按「部署」，複製產生的網址（形如 `https://script.google.com/macros/s/AKfy.../exec`）。

「誰可以存取」若設成「只有我」，玩家會拿到 401；設成「所有人」時 Apps Script 是以你的身分讀寫 Sheet，玩家本身不需要 Google 帳號、也碰不到 Sheet 原始資料。

- [ ] **Step 3: 驗證 doGet 真的回得出東西**

```bash
curl -sL "<貼上你的 Web App 網址>" | python3 -m json.tool
```

`-L` 不可省略：Apps Script 會 302 轉址到 `script.googleusercontent.com`，少了它只會拿到空回應。

預期輸出包含 `"ok": true`、一個合理的 `mkt`、`"closed": false`，以及 `roster` 內兩筆（阿明 82000、小美 78000）。

阿明那筆的 `bet` 若是 85000，代表 `rosterFromRows` 沒接上；`roster` 若是空的，代表 `SHEET_ID` 指錯。

- [ ] **Step 4: 寫 README 骨架**

建立 `README.md`：

````markdown
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
````

- [ ] **Step 5: 提交**

```bash
git add src/Code.gs README.md
git commit -m "新增 doGet 與 Web App 部署文件

doGet 一次回傳市價、剩餘天數、容許值、截止狀態與全場最新一筆，
讓前端不必自行推算任何與計分有關的數字。

README 特別註明改完程式碼要新增部署版本，只按儲存不會生效——
這個坑會讓人 debug 很久。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: doPost — 身分驗證、冪等、截止、寫入

整個防作弊設計的核心在這裡：前端只送 `name` / `pin` / `bet` / `nonce` 四個欄位，其餘一律由伺服器產生。

**Files:**
- Modify: `src/Code.gs`

**Interfaces:**
- Consumes: Task 4 的 `sheet_`、`betRows_`、`json_`、`nowIso_`、`fetchMarketPrice_`；Task 1 的 `normalizeName`、`daysLeftFrom`、`tolFor`、`gutsOf`、`isClosed`；Task 2 的 `rosterFromRows`、`nextSeq`、`hasRecentNonce`
- Produces:
  - `pinHash_(playerId: string, pin: string) => string`（SHA-256 十六進位）
  - `authenticate_(playerId, name, pin, now) => { ok: true, registered?: true } | { ok: false, reason: 'wrong_pin', message: string }`
  - `doPost(e) => TextOutput`
  - 成功回傳：`{ ok: true, seq, tol, daysLeft, mkt, guts, roster }`
  - 失敗回傳：`{ ok: false, reason, message }`，`reason` 取值為 `closed` / `bad_name` / `bad_pin` / `bad_bet` / `bad_nonce` / `wrong_pin` / `server_error`

- [ ] **Step 1: 實作 PIN 雜湊與身分驗證**

在 `src/Code.gs` 的 `doGet` 之前插入：

```js
// ====== 身分 ======

// PIN 不存明碼。加入 playerId 當鹽，避免兩個人用同一組 PIN 產生相同雜湊。
function pinHash_(playerId, pin) {
  const raw = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    pin + '|' + playerId,
    Utilities.Charset.UTF_8
  );
  return raw.map((b) => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

// 首次送出即註冊；之後同一個 player_id 必須 PIN 相符。
// 這同時擋掉冒名去改別人的注。
function authenticate_(playerId, name, pin, now) {
  const sh = sheet_('players');
  const last = sh.getLastRow();
  const rows = (last < 2) ? [] : sh.getRange(2, 1, last - 1, 4).getValues();
  const h = pinHash_(playerId, pin);

  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] === playerId) {
      if (rows[i][2] === h) return { ok: true };
      return {
        ok: false,
        reason: 'wrong_pin',
        message: '「' + name + '」這個名字已經有人用了，PIN 不對。換個名字，或確認你自己的 PIN。'
      };
    }
  }

  sh.appendRow([playerId, name, h, nowIso_(now)]);
  return { ok: true, registered: true };
}
```

- [ ] **Step 2: 實作 doPost**

在 `src/Code.gs` 的 `doGet` 之後追加：

```js
function doPost(e) {
  const lock = LockService.getScriptLock();
  // 併發寫入會讓兩個人拿到同一個 seq，導致 rosterFromRows 取錯筆。
  lock.waitLock(20000);
  try {
    const body = JSON.parse(e.postData.contents);
    const now = new Date();
    const nowMs = now.getTime();

    // 截止寫死在伺服器端。前端隱藏按鈕只是輔助，不能當作規則。
    if (isClosed(nowMs)) {
      return json_({ ok: false, reason: 'closed', message: '下注已於 9/11 00:00 截止。' });
    }

    const name = String(body.name == null ? '' : body.name).trim();
    const pin = String(body.pin == null ? '' : body.pin).trim();
    const bet = Number(body.bet);
    const nonce = String(body.nonce == null ? '' : body.nonce);

    if (!name) return json_({ ok: false, reason: 'bad_name', message: '請填名字。' });
    if (!/^\d{4}$/.test(pin)) return json_({ ok: false, reason: 'bad_pin', message: 'PIN 必須是 4 位數字。' });
    if (!isFinite(bet) || bet <= 0) return json_({ ok: false, reason: 'bad_bet', message: '預測價不正確。' });
    if (!nonce) return json_({ ok: false, reason: 'bad_nonce', message: '缺少 nonce。' });

    const playerId = normalizeName(name);
    const rows = betRows_();

    // 雙擊或網路重試會用同一個 nonce 再送一次，回成功但不重複寫。
    if (hasRecentNonce(rows, nonce, nowMs)) {
      return json_({ ok: true, duplicate: true, roster: rosterFromRows(rows) });
    }

    const auth = authenticate_(playerId, name, pin, now);
    if (!auth.ok) return json_(auth);

    const priced = fetchMarketPrice_();
    const dl = daysLeftFrom(nowMs);
    const tol = tolFor(dl);
    const guts = gutsOf(bet, priced.price);
    const seq = nextSeq(rows, playerId);

    // 欄序必須與 BET_COLS 一致
    sheet_('bets').appendRow([
      nowIso_(now), playerId, name, seq, dl, tol,
      priced.price, bet, guts, priced.src, nonce
    ]);

    return json_({
      ok: true, seq: seq, tol: tol, daysLeft: dl,
      mkt: priced.price, guts: guts,
      roster: rosterFromRows(betRows_())
    });
  } catch (err) {
    return json_({ ok: false, reason: 'server_error', message: String(err) });
  } finally {
    lock.releaseLock();
  }
}
```

- [ ] **Step 3: 打包並重新部署**

```bash
./tools/build-gas.sh
```

貼進 Apps Script，然後「部署 → 管理部署作業 → 編輯 → 版本選『新版本』→ 部署」。網址不變。

- [ ] **Step 4: 用 curl 驗證六個情境**

把 `<URL>` 換成你的部署網址。`Content-Type` 必須是 `text/plain`，這是繞過 CORS preflight 的關鍵，也是前端實際會送的格式。

**4a. 首次下注應成功並註冊：**

```bash
curl -sL -X POST "<URL>" -H 'Content-Type: text/plain;charset=utf-8' \
  -d '{"name":"測試甲","pin":"1234","bet":80000,"nonce":"t-001"}' | python3 -m json.tool
```

預期 `"ok": true`、`"seq": 1`、`tol` 為今天對應的容許值。`players` 分頁應多出一列「測試甲」。

**4b. 同一個 nonce 再送一次，不可重複寫入：**

```bash
curl -sL -X POST "<URL>" -H 'Content-Type: text/plain;charset=utf-8' \
  -d '{"name":"測試甲","pin":"1234","bet":80000,"nonce":"t-001"}' | python3 -m json.tool
```

預期 `"ok": true`、`"duplicate": true`。`bets` 分頁的列數**不變**。

**4c. 改注（換 nonce）應寫入第二列：**

```bash
curl -sL -X POST "<URL>" -H 'Content-Type: text/plain;charset=utf-8' \
  -d '{"name":"測試甲","pin":"1234","bet":86000,"nonce":"t-002"}' | python3 -m json.tool
```

預期 `"seq": 2`。`bets` 多一列，且 `roster` 裡「測試甲」的 `bet` 是 86000。

**4d. PIN 錯誤必須被擋，且不寫入：**

```bash
curl -sL -X POST "<URL>" -H 'Content-Type: text/plain;charset=utf-8' \
  -d '{"name":"測試甲","pin":"9999","bet":70000,"nonce":"t-003"}' | python3 -m json.tool
```

預期 `"ok": false`、`"reason": "wrong_pin"`，訊息包含名字。`bets` 列數不變。

**4e. 全形名字要認得是同一個人：**

```bash
curl -sL -X POST "<URL>" -H 'Content-Type: text/plain;charset=utf-8' \
  -d '{"name":"　測試甲　","pin":"1234","bet":81000,"nonce":"t-004"}' | python3 -m json.tool
```

預期 `"seq": 3`（接續而非從 1 開始），`players` 不會多出新玩家。

**4f. PIN 格式錯誤：**

```bash
curl -sL -X POST "<URL>" -H 'Content-Type: text/plain;charset=utf-8' \
  -d '{"name":"測試乙","pin":"12","bet":80000,"nonce":"t-005"}' | python3 -m json.tool
```

預期 `"reason": "bad_pin"`。`players` 不會多出「測試乙」——驗證要排在註冊之前。

**4g. 截止後必須拒收：**

現在是 8/26，無法等到 9/11，所以暫時把截止時間往前調來驗。在 Apps Script 編輯器裡把
`SETTLE_MS` 那一行改成一個已經過去的時刻：

```js
const SETTLE_MS = Date.parse('2026-08-01T00:00:00+08:00');  // 暫時,驗完要改回來
```

存檔並「管理部署作業 → 編輯 → 新版本 → 部署」，然後：

```bash
curl -sL -X POST "<URL>" -H 'Content-Type: text/plain;charset=utf-8' \
  -d '{"name":"測試甲","pin":"1234","bet":80000,"nonce":"t-006"}' | python3 -m json.tool
```

預期 `"ok": false`、`"reason": "closed"`。`bets` 列數不變。

**驗完務必把 `SETTLE_MS` 改回 `2026-09-11T00:00:00+08:00` 並重新部署新版本。**
接著再送一次 `t-007` 確認又能正常寫入——這一步不能省，忘了改回來整場遊戲就從一開始就是截止狀態。

- [ ] **Step 5: 檢查 Sheet 內容**

打開 `bets`，測試甲應有三列，`seq` 為 1 / 2 / 3，每列的 `ts`、`days_left`、`tol`、`mkt` 都有值且合理。`current` 分頁應自動多出「測試甲」一列，改注次數為 2。

確認完把測試列從 `bets` 與 `players` 刪掉。這是這份 Sheet 唯一允許手動刪列的時機——正式開賽後 `bets` 必須是純 append-only。

- [ ] **Step 6: 提交**

```bash
git add src/Code.gs
git commit -m "新增 doPost：身分驗證、冪等、截止與寫入

前端只送 name/pin/bet/nonce 四個欄位，ts、days_left、tol、mkt
一律由伺服器產生，玩家無法宣稱自己更早下注或市價是別的數字。

用 LockService 序列化寫入，否則併發下兩個人會拿到同一個 seq，
rosterFromRows 就會取錯筆。

PIN 加 playerId 當鹽再雜湊，避免兩人用同一組 PIN 產生相同雜湊。
格式驗證排在註冊之前，PIN 格式錯不會留下半個玩家紀錄。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: 前端 API client

把 fetch 與 localStorage 從 `index.html` 抽出來成為可測試的模組。兩者都由外部注入，測試才能用 stub 跑完離線與失敗路徑。

**Files:**
- Create: `src/api.js`
- Create: `test/api.test.js`

**Interfaces:**
- Consumes: Task 5 的 `doGet` 回應結構、Task 6 的 `doPost` 請求與回應結構
- Produces（掛在 `globalThis.ChickenApi`，Node 下為 `module.exports`）：
  - `makeNonce() => string`
  - `createApi({ url, fetch?, storage? }) => Client`
  - `Client.getState() => Promise<object>`
  - `Client.placeBet({ name, pin, bet, nonce? }) => Promise<object>`
  - `Client.loadPending() => object | null`
  - `Client.clearPending() => void`
  - `Client.saveMe(name, pin) => void`
  - `Client.loadMe() => { name, pin } | null`

- [ ] **Step 1: 寫失敗的測試**

建立 `test/api.test.js`：

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createApi, makeNonce } = require('../src/api.js');

function fakeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _map: m
  };
}

const okResponse = (body) => ({ ok: true, status: 200, json: async () => body });

test('makeNonce 每次都不一樣', () => {
  const s = new Set();
  for (let i = 0; i < 200; i++) s.add(makeNonce());
  assert.strictEqual(s.size, 200);
});

test('getState 打 GET 並回傳解析後的 JSON', async () => {
  const calls = [];
  const api = createApi({
    url: 'https://example.test/exec',
    fetch: async (u, o) => { calls.push([u, o]); return okResponse({ ok: true, mkt: 78000 }); },
    storage: fakeStorage()
  });
  const s = await api.getState();
  assert.strictEqual(s.mkt, 78000);
  assert.strictEqual(calls[0][1].method, 'GET');
});

test('placeBet 用 text/plain 送出，避免觸發 CORS preflight', async () => {
  let seen = null;
  const api = createApi({
    url: 'https://example.test/exec',
    fetch: async (u, o) => { seen = o; return okResponse({ ok: true, seq: 1 }); },
    storage: fakeStorage()
  });
  await api.placeBet({ name: '阿明', pin: '1234', bet: 82000 });
  assert.strictEqual(seen.method, 'POST');
  assert.strictEqual(seen.headers['Content-Type'], 'text/plain;charset=utf-8');
  const body = JSON.parse(seen.body);
  assert.strictEqual(body.bet, 82000);
  assert.ok(body.nonce, '沒帶 nonce 就無法冪等');
});

test('placeBet 只送四個欄位，不送任何伺服器該自己算的值', async () => {
  let seen = null;
  const api = createApi({
    url: 'https://example.test/exec',
    fetch: async (u, o) => { seen = o; return okResponse({ ok: true }); },
    storage: fakeStorage()
  });
  await api.placeBet({ name: '阿明', pin: '1234', bet: 82000, mkt: 1, tol: 99, ts: 'fake' });
  assert.deepStrictEqual(Object.keys(JSON.parse(seen.body)).sort(), ['bet', 'name', 'nonce', 'pin']);
});

test('placeBet 失敗時把這筆暫存起來並把錯誤往上丟', async () => {
  const store = fakeStorage();
  const api = createApi({
    url: 'https://example.test/exec',
    fetch: async () => { throw new Error('network down'); },
    storage: store
  });
  await assert.rejects(() => api.placeBet({ name: '阿明', pin: '1234', bet: 82000 }));
  const pending = api.loadPending();
  assert.strictEqual(pending.bet, 82000);
  assert.ok(pending.nonce);
});

test('重送暫存時沿用同一個 nonce，伺服器才擋得掉重複', async () => {
  const store = fakeStorage();
  let fail = true;
  const api = createApi({
    url: 'https://example.test/exec',
    fetch: async (u, o) => {
      if (fail) throw new Error('network down');
      return okResponse({ ok: true, seq: 1, _echo: JSON.parse(o.body) });
    },
    storage: store
  });
  await assert.rejects(() => api.placeBet({ name: '阿明', pin: '1234', bet: 82000 }));
  const first = api.loadPending().nonce;
  fail = false;
  const res = await api.placeBet(api.loadPending());
  assert.strictEqual(res._echo.nonce, first);
  assert.strictEqual(api.loadPending(), null, '成功後應清掉暫存');
});

test('HTTP 非 2xx 視為失敗並暫存', async () => {
  const store = fakeStorage();
  const api = createApi({
    url: 'https://example.test/exec',
    fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    storage: store
  });
  await assert.rejects(() => api.placeBet({ name: '阿明', pin: '1234', bet: 82000 }));
  assert.ok(api.loadPending());
});

test('伺服器回 ok:false 時不丟例外，由呼叫端判讀 reason', async () => {
  const store = fakeStorage();
  const api = createApi({
    url: 'https://example.test/exec',
    fetch: async () => okResponse({ ok: false, reason: 'wrong_pin', message: 'PIN 不對' }),
    storage: store
  });
  const res = await api.placeBet({ name: '阿明', pin: '9999', bet: 82000 });
  assert.strictEqual(res.reason, 'wrong_pin');
  assert.strictEqual(api.loadPending(), null, 'PIN 錯不該留成待重送');
});

test('saveMe / loadMe 記得身分，免得每次重打', () => {
  const api = createApi({ url: 'x', fetch: async () => okResponse({}), storage: fakeStorage() });
  assert.strictEqual(api.loadMe(), null);
  api.saveMe('阿明', '1234');
  assert.deepStrictEqual(api.loadMe(), { name: '阿明', pin: '1234' });
});

test('storage 整個壞掉時不可讓下注流程炸掉', async () => {
  const broken = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
    removeItem: () => { throw new Error('blocked'); }
  };
  const api = createApi({ url: 'x', fetch: async () => okResponse({ ok: true }), storage: broken });
  assert.strictEqual(api.loadPending(), null);
  assert.strictEqual(api.loadMe(), null);
  const res = await api.placeBet({ name: '阿明', pin: '1234', bet: 82000 });
  assert.strictEqual(res.ok, true);
});
```

最後一題涵蓋無痕視窗與封鎖 cookie 的瀏覽器：`localStorage` 存取本身就會丟例外，不能讓下注跟著掛掉。

- [ ] **Step 2: 跑測試確認它失敗**

```bash
node --test
```

預期：`test/api.test.js` 全部 fail，訊息為 `Cannot find module '../src/api.js'`。`test/lib.test.js` 的 18 題仍應 pass。

- [ ] **Step 3: 寫實作**

建立 `src/api.js`：

```js
(function (global) {
  'use strict';

  const PENDING_KEY = 'chickendinner:pending';
  const ME_KEY = 'chickendinner:me';

  function makeNonce() {
    return Math.random().toString(36).slice(2, 10) +
           '-' + Date.now().toString(36) +
           '-' + Math.random().toString(36).slice(2, 6);
  }

  function createApi(opts) {
    const url = opts.url;
    const doFetch = opts.fetch || global.fetch.bind(global);
    const store = opts.storage || global.localStorage;

    // localStorage 在無痕視窗或封鎖 cookie 時，光是存取就會丟例外。
    // 全部包起來，儲存壞掉不能讓下注流程跟著掛掉。
    function readKey(k) {
      try { const v = store.getItem(k); return v ? JSON.parse(v) : null; }
      catch (e) { return null; }
    }
    function writeKey(k, v) {
      try { store.setItem(k, JSON.stringify(v)); } catch (e) { /* 忽略 */ }
    }
    function dropKey(k) {
      try { store.removeItem(k); } catch (e) { /* 忽略 */ }
    }

    async function getState() {
      const res = await doFetch(url, { method: 'GET' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }

    async function placeBet(payload) {
      // 只送這四個欄位。ts、mkt、tol、days_left 一律由伺服器產生。
      const body = {
        name: payload.name,
        pin: payload.pin,
        bet: Number(payload.bet),
        nonce: payload.nonce || makeNonce()
      };
      let data;
      try {
        const res = await doFetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        data = await res.json();
      } catch (err) {
        // 送不出去才暫存。伺服器有回應就代表這個 nonce 已經到過，不必重送。
        writeKey(PENDING_KEY, body);
        throw err;
      }
      dropKey(PENDING_KEY);
      return data;
    }

    return {
      getState: getState,
      placeBet: placeBet,
      loadPending: () => readKey(PENDING_KEY),
      clearPending: () => dropKey(PENDING_KEY),
      saveMe: (name, pin) => writeKey(ME_KEY, { name: name, pin: pin }),
      loadMe: () => readKey(ME_KEY),
      makeNonce: makeNonce
    };
  }

  const api = { createApi: createApi, makeNonce: makeNonce, PENDING_KEY: PENDING_KEY, ME_KEY: ME_KEY };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.ChickenApi = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
```

- [ ] **Step 4: 跑測試確認通過**

```bash
node --test
```

預期：`# pass 28` / `# fail 0`。

- [ ] **Step 5: 提交**

```bash
git add src/api.js test/api.test.js
git commit -m "新增前端 API client

fetch 與 storage 由外部注入，測試才跑得到離線與失敗路徑。

placeBet 只送 name/pin/bet/nonce，伺服器該自己算的值即使呼叫端
傳進來也會被丟掉，避免哪天前端不小心把 mkt 送上去。

只有在請求送不出去時才暫存待重送；伺服器已回應（含 ok:false）
代表這個 nonce 到過了，重送只會被冪等擋掉，沒有意義。

localStorage 的每個存取都包了 try/catch——無痕視窗光是存取就會
丟例外，不能讓下注流程跟著掛掉。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: index.html 接上 API、改注流程、移除危險按鈕

前端改動幅度大，`<script>` 區塊幾乎全換。這一步先讓功能跑通，走勢圖留到 Task 9。

**Files:**
- Rename: `chicken-dinner-bankee.html` → `index.html`
- Modify: `index.html`

**Interfaces:**
- Consumes: Task 1、2 的 `src/lib.js`（`SETTLE_MS`、`multOf`、`tolFor`、`gutsOf`）；Task 7 的 `src/api.js`（`ChickenApi.createApi`）；Task 5 的 Web App 網址
- Produces: 可實際下注與改注的頁面

- [ ] **Step 1: 改名並載入兩個模組**

```bash
git mv chicken-dinner-bankee.html index.html
```

在 `index.html` 的 `<script>` 開頭之前插入：

```html
<script src="src/lib.js"></script>
<script src="src/api.js"></script>
```

`src/lib.js` 是一般 script（非 module），它在頂層宣告的 `const` 位於全域詞法作用域，後續的 script 讀得到。

- [ ] **Step 2: 改 HTML 標記**

**2a.** 找到下注頁第一張卡片裡的三格 `.f3`，把「下注日」那一格整格刪掉，並把外層改成兩欄。原本是：

```html
<div class="f3">
  <div><span class="lbl">下注日</span><select id="day"></select></div>
  <div><span class="lbl">當下市價</span><div class="num" style="padding-top:7px">$<span id="mkt"></span></div></div>
  <div><span class="lbl">容許誤差</span><div class="num" style="padding-top:7px">±<span id="tol"></span><small>%</small></div></div>
</div>
```

改成：

```html
<div class="f3" style="grid-template-columns:1fr 1fr">
  <div><span class="lbl">當下市價</span><div class="num" style="padding-top:7px">$<span id="mkt">—</span></div></div>
  <div><span class="lbl">容許誤差</span><div class="num" style="padding-top:7px">±<span id="tol">—</span><small>%</small></div></div>
</div>
```

下注日改由伺服器蓋章，玩家不能選——這是防作弊的一部分。

**2b.** 把送出區塊換成含 PIN 的版本。原本是：

```html
<div class="act">
  <input type="text" id="name" placeholder="你的名字" maxlength="8" aria-label="你的名字">
  <button class="go" id="submit">下注</button>
</div>
```

改成：

```html
<div class="act">
  <select id="name" aria-label="你的名字" style="flex:1"></select>
  <input type="text" id="pin" placeholder="PIN" inputmode="numeric" maxlength="4"
         aria-label="4 位數 PIN" style="flex:0 0 76px;text-align:center">
  <button class="go" id="submit">下注</button>
</div>
<p class="sub" style="margin-top:8px">
  PIN 是你自己設的 4 位數字，用來認回自己。<b>換手機或清快取都要用它改注，請記牢。</b>
</p>
```

**2c.** 刪掉戰況頁的兩個按鈕：

```html
<button class="ghost" id="demo">載入 13 人範例</button>
<button class="ghost" id="clear">清空紀錄</button>
```

「清空紀錄」目前任何人按下去都會刪掉全場所有人的下注，接上 Sheet 之後絕不能留。

**2d.** 在戰況頁「排行榜」卡片的 `<h2>` 之後插入連線狀態列：

```html
<div class="sub" id="conn" style="margin-top:6px">連線中…</div>
```

**2e.** 假設結算價滑桿的範圍寫死在 HTML，真實 BTC 價格可能整個落在範圍外導致滑桿無用。
把兩端的標籤加上 id 讓程式接手：

```html
<div class="ends"><span id="slo">—</span><span>拉動看排名怎麼洗牌</span><span id="shi">—</span></div>
```

`<input type="range" id="settle" min="68000" max="94000" step="250" …>` 的 `min` / `max`
留著當載入前的預設值即可，`renderBoard()` 會依實際市價覆寫。

- [ ] **Step 3: 換掉整個 script 區塊**

把 `<script>` 與 `</script>` 之間的內容全部換成：

```js
const API_URL = 'PUT_YOUR_WEB_APP_URL_HERE';  // ← 換成 Task 5 的部署網址
const TARGET = 25;                            // 參加人數，只影響「已下注 N/25」的顯示
const T0 = Date.parse('2026-08-26T00:00:00+08:00');  // 圖表時間軸起點
const T1 = SETTLE_MS;                                 // 來自 src/lib.js

const $ = i => document.getElementById(i);
const fmt = n => Math.round(n).toLocaleString('en-US');
const esc = s => String(s).replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));

const api = ChickenApi.createApi({ url: API_URL });

let S = { mkt: 0, tol: 0, daysLeft: 0, closed: false, roster: [], serverTime: '' };
let bet = 0;           // 目前輸入的預測價
let settle = 0;        // 戰況頁的假設結算價
let mine = null;       // 我最新一筆（從 roster 認出來）
let klines = [];       // Task 9 會填入真實走勢
let pollTimer = null;
let busy = false;

/* ===== 共用 ===== */
function drum(k){
  const f = Math.floor(k), fr = k - f;
  let s = "🍗".repeat(Math.min(f, 5));
  if (fr > .12 && f < 5) s += `<span style="opacity:${(.22+fr*.78).toFixed(2)}">🍗</span>`;
  return s || `<span style="opacity:.16">🍗</span>`;
}
function myName(){ return ($("name").value || '').trim(); }
// 用正規化後的名字比對,否則「阿明」與「 阿明 」會被當成兩個人,
// 玩家就看不到自己那一點被標成金色。
function isMine(r){ return !!mine && normalizeName(r.name) === normalizeName(mine.name); }
function conn(msg, bad){
  $("conn").textContent = msg;
  $("conn").style.color = bad ? 'var(--coral)' : 'var(--navy-2)';
}

/* ===== 狀態同步 ===== */
async function refresh(){
  try {
    const s = await api.getState();
    if (!s.ok) throw new Error(s.message || '伺服器回報錯誤');
    S = s;
    if (!settle) settle = Math.round(S.mkt);
    if (!bet) bet = Math.round(S.mkt);
    conn(S.src === 'fallback'
      ? '市價暫時抓不到,顯示的是最後一次成功的價格。'
      : `已同步 · 市價 $${fmt(S.mkt)} · 剩 ${S.daysLeft} 天 · 容許 ±${S.tol}%`);
    renderBoard(); render();
  } catch (err) {
    conn('連線不到伺服器,畫面可能不是最新的。' + err.message, true);
  }
}

/* ===== 戰況 ===== */
function scoreOf(r){ return multOf(r.bet, r.mkt, settle, r.tol); }

function renderBoard(){
  // 滑桿範圍跟著實際市價走,不能寫死——BTC 價格可能整個落在寫死的區間外。
  if (S.mkt) {
    const slo = Math.round(S.mkt*.85), shi = Math.round(S.mkt*1.15);
    settle = Math.min(shi, Math.max(slo, settle));
    Object.assign($("settle"), { min: slo, max: shi, step: 250 });
    $("slo").textContent = fmt(slo); $("shi").textContent = fmt(shi);
  }
  $("sv").textContent = fmt(settle);
  $("settle").value = settle;
  const N = S.roster.length;
  const tot = S.roster.reduce((a, r) => a + scoreOf(r), 0);
  const win = S.roster.filter(r => scoreOf(r) >= 1).length;
  $("pCount").innerHTML = N + `<small>/${TARGET}</small>`;
  $("pTotal").innerHTML = tot.toFixed(1) + "<small> 份</small>";
  $("pWin").innerHTML = win + "<small> 人</small>";
  const d = N - tot;
  $("sDiff").innerHTML = (d >= 0 ? "+" : "") + d.toFixed(1) + "<small> 份</small>";
  $("sDiff").style.color = d >= 0 ? "var(--aqua-d)" : "var(--coral)";
  drawScatter(); drawList();
}

function drawScatter(){
  const W = 390, H = 300, L = 40, R = 10, T = 16, B = 30;
  const ps = S.roster.map(r => r.bet).concat([settle, S.mkt]).filter(v => v > 0);
  if (!ps.length) { $("board").innerHTML = ''; return; }
  let lo = Math.min(...ps), hi = Math.max(...ps);
  const pd = (hi - lo) * .1 || 1000; lo -= pd; hi += pd;

  const x = ms => L + (Math.min(Math.max(ms, T0), T1) - T0) / (T1 - T0) * (W - L - R);
  const y = p => H - B - (p - lo) / (hi - lo) * (H - B - T);
  let s = "";

  for (let i = 0; i <= 4; i++) {
    const p = lo + (hi - lo) * i / 4;
    s += `<line x1="${L}" y1="${y(p)}" x2="${W-R}" y2="${y(p)}" stroke="#E2EAEE"/>
    <text x="${L-5}" y="${y(p)+3.5}" text-anchor="end" font-size="8.5" font-weight="600" fill="#3A5872">${fmt(p/1000)}k</text>`;
  }
  s += `<line x1="${L}" y1="${y(settle)}" x2="${W-R}" y2="${y(settle)}" stroke="#FF6B5A" stroke-width="1.5" stroke-dasharray="5 4"/>
  <text x="${W-R}" y="${y(settle)-6}" text-anchor="end" font-size="9" font-weight="800" fill="#FF6B5A">假設 ${fmt(settle)}</text>`;

  if (klines.length > 1) {
    s += `<polyline points="${klines.map(k => `${x(k.t)},${y(k.close)}`).join(' ')}" fill="none" stroke="#00BFC4" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`;
  }

  const seen = {};
  S.roster.forEach(r => {
    const ms = Date.parse(r.ts); if (isNaN(ms)) return;
    const cx = x(ms), cy = y(r.bet), m = scoreOf(r);
    const isMe = isMine(r);
    s += `<line x1="${cx}" y1="${cy}" x2="${cx}" y2="${y(r.mkt)}" stroke="#3A5872" stroke-opacity=".35" stroke-dasharray="2 3"/>`;
    s += `<circle cx="${cx}" cy="${cy}" r="${isMe?6.5:5.5}" fill="${m>=1?'#00BFC4':'#FF6B5A'}" stroke="${isMe?'#FFB020':'#fff'}" stroke-width="${isMe?2.5:1.5}"/>`;
    const bucket = Math.round(cx/30) + ':' + Math.round(cy/12);
    const dy = seen[bucket] ? 12 : 3.5; seen[bucket] = 1;
    s += `<text x="${cx+9}" y="${cy+dy}" font-size="9.5" font-weight="700" fill="#0E2A42">${esc(r.name)}</text>`;
  });

  [['8/26', T0], ['8/31', Date.parse('2026-08-31T00:00:00+08:00')],
   ['9/05', Date.parse('2026-09-05T00:00:00+08:00')], ['9/11', T1]].forEach(([lbl, ms], i) => {
    s += `<text x="${x(ms)}" y="${H-B+15}" text-anchor="${i===0?'start':i===3?'end':'middle'}" font-size="8.5" font-weight="600" fill="#3A5872">${lbl}</text>`;
  });
  $("board").innerHTML = s;
}

function drawList(){
  const el = $("plist"); el.innerHTML = "";
  $("empty").style.display = S.roster.length ? "none" : "block";
  const sorted = S.roster.slice().sort((a, b) => scoreOf(b) - scoreOf(a));
  const top = sorted.length ? scoreOf(sorted[0]) : 1;
  sorted.forEach((r, i) => {
    const m = scoreOf(r);
    const isMe = isMine(r);
    const d = document.createElement("div");
    d.className = "p" + (m>=1 ? "" : " lose") + (i===0 && m>=1 ? " gold" : "") + (isMe ? " me" : "");
    const day = new Date(Date.parse(r.ts));
    const dayLbl = (day.getMonth()+1) + '/' + String(day.getDate()).padStart(2,'0');
    d.innerHTML = `<div class="fill" style="width:${Math.min(100, m/Math.max(top,1)*100)}%"></div>
      <div class="rk">${i+1}</div>
      <div class="av">${esc(r.name.slice(0,1))}</div>
      <div class="pi">
        <div class="pn">${esc(r.name)}${isMe?'<span class="tag">你</span>':''}</div>
        <div class="pm">${dayLbl} · 押 ${fmt(r.bet)} · 膽量 ${r.guts.toFixed(1)}% · 容許 ±${r.tol}%</div>
      </div>
      <div class="px"><div class="x">${m.toFixed(2)}×</div><div class="d">${drum(m)}</div></div>`;
    el.appendChild(d);
  });
}

/* ===== 下注 ===== */
function render(){
  if (!S.mkt) return;
  const mkt = S.mkt, tol = S.tol;
  const lo = Math.round(mkt*.86), hi = Math.round(mkt*1.14);
  bet = Math.min(hi, Math.max(lo, bet || Math.round(mkt)));
  $("mkt").textContent = fmt(mkt);
  $("tol").textContent = tol;
  $("dleft").textContent = S.daysLeft;
  $("bet").value = fmt(bet);
  Object.assign($("slider"), { min: lo, max: hi, step: 100, value: bet });
  $("rlo").textContent = fmt(lo); $("rhi").textContent = fmt(hi);

  const g = gutsOf(bet, mkt), k = 1 + g/10;
  $("guts").textContent = g.toFixed(2) + "%";
  $("zero").textContent = "誤差 >" + tol + "%";
  $("kmax").textContent = k.toFixed(2) + "×";
  $("plates").innerHTML = drum(k);
  const v = $("verdict");
  v.textContent = k>=1.5 ? "WINNER WINNER!" : k>=1.15 ? "CHICKEN DINNER" : "只夠回本";
  v.className = "vd" + (k>=1.15 ? "" : " lose");
  $("m2").textContent = Math.max(0, k*(1-2/tol)).toFixed(2) + "×";
  $("m5").textContent = Math.max(0, k*(1-5/tol)).toFixed(2) + "×";
  $("m8").textContent = Math.max(0, k*(1-8/tol)).toFixed(2) + "×";

  $("submit").textContent = mine ? "改注" : "下注";
  $("submit").disabled = busy || S.closed;
  if (S.closed) $("msg").textContent = "已於 9/11 00:00 截止,不能再改了。";
  drawCurve(mkt, tol);
}

function drawCurve(mkt, tol){
  const W = 390, H = 175, L = 30, B = 26, T = 16;
  const lo = mkt*.88, hi = mkt*1.12, N = 23, pts = [];
  for (let i = 0; i < N; i++) { const s = lo + (hi-lo)*i/(N-1); pts.push([s, multOf(bet, mkt, s, tol)]); }
  const my = Math.max(1.7, ...pts.map(p => p[1])) * 1.12;
  const x = s => L + (s-lo)/(hi-lo)*(W-L-8), y = v => H-B-(v/my)*(H-B-T), bw = (W-L-8)/N-2.5;
  let s = `<line x1="${L}" y1="${y(1)}" x2="${W-8}" y2="${y(1)}" stroke="#FF6B5A" stroke-width="1.2" stroke-dasharray="5 3"/>
  <text x="${L-4}" y="${y(1)+3.5}" text-anchor="end" font-size="8.5" font-weight="700" fill="#FF6B5A">1.0</text>
  <line x1="${L}" y1="${H-B}" x2="${W-8}" y2="${H-B}" stroke="#E2EAEE" stroke-width="1.5"/>`;
  pts.forEach(([sv, v]) => { s += `<rect x="${x(sv)-bw/2}" y="${y(v)}" width="${bw}" height="${Math.max(0,(H-B)-y(v))}" rx="2" fill="${v>=1?'#00BFC4':'#CBD9E0'}"/>`; });
  s += `<line x1="${x(bet)}" y1="${T-8}" x2="${x(bet)}" y2="${H-B}" stroke="#FFB020" stroke-width="2"/>
  <text x="${x(bet)}" y="${T-11}" text-anchor="middle" font-size="9" font-weight="800" fill="#FFB020">你押這</text>`;
  [lo, mkt, hi].forEach((v, i) => { s += `<text x="${x(v)}" y="${H-B+14}" text-anchor="${i===0?'start':i===2?'end':'middle'}" font-size="8.5" font-weight="600" fill="#3A5872">${fmt(v)}</text>`; });
  $("chart").innerHTML = s;
}

/* ===== 送出 ===== */
async function submitBet(payload){
  busy = true; $("submit").disabled = true;
  try {
    const res = await api.placeBet(payload);
    if (!res.ok) {
      // 伺服器有回應但拒絕:輸入全部保留,讓玩家改完再送。
      $("msg").textContent = res.message || ('送出被拒:' + res.reason);
      $("msg").style.color = 'var(--coral)';
      return false;
    }
    api.saveMe(payload.name, payload.pin);
    mine = { name: payload.name };
    $("msg").style.color = 'var(--aqua-d)';
    $("msg").textContent = res.duplicate
      ? '這筆剛剛已經送出過了,沒有重複記錄。'
      : `${payload.name} 押 $${fmt(payload.bet)} 已入場（第 ${res.seq} 次送出）。截止前還可以再改。`;
    await refresh();
    return true;
  } catch (err) {
    // 送不出去:api.js 已暫存,提示可重送。輸入不清空、按鈕要放開。
    $("msg").style.color = 'var(--coral)';
    $("msg").textContent = '送不出去(' + err.message + ')。已幫你存起來,連上網後按一次「重送」。';
    return false;
  } finally {
    busy = false; render();
  }
}

// 名字下拉選單由 ROSTER 產生（來自 src/lib.js）。第一個選項是空的占位,
// 逼玩家主動選,免得有人沒注意就用了預設的第一個人的名字下注。
(function fillNames(){
  const sel = $("name");
  sel.innerHTML = '<option value="">— 選你的名字 —</option>';
  ROSTER.forEach(n => {
    const o = document.createElement('option');
    o.value = n; o.textContent = n; sel.appendChild(o);
  });
})();

$("submit").onclick = () => {
  const name = myName(), pin = ($("pin").value || '').trim();
  $("msg").style.color = 'var(--coral)';
  if (!name) { $("msg").textContent = "先從選單選你的名字。"; $("name").focus(); return; }
  if (!/^\d{4}$/.test(pin)) { $("msg").textContent = "PIN 要 4 位數字。"; $("pin").focus(); return; }
  submitBet({ name, pin, bet });
};

/* ===== 分頁與控制項 ===== */
[["t1","p1"],["t2","p2"]].forEach(([t,p],i) => {
  $(t).onclick = () => {
    ["t1","t2"].forEach((x,j) => $(x).setAttribute("aria-selected", j===i));
    $("p1").hidden = i!==0; $("p2").hidden = i!==1;
    window.scrollTo({ top:0, behavior:'smooth' });
    if (i===0) renderBoard();
  };
});
$("settle").oninput = e => { settle = +e.target.value; renderBoard(); };
$("slider").oninput = e => { bet = +e.target.value; render(); };
$("bet").onchange = e => { const v = +e.target.value.replace(/[^\d]/g,''); if (v) bet = v; render(); };
document.querySelectorAll(".nudge button").forEach(b => b.onclick = () => { bet += +b.dataset.d; render(); });

/* ===== 啟動 ===== */
(async function boot(){
  const saved = api.loadMe();
  if (saved) { $("name").value = saved.name; $("pin").value = saved.pin; }

  await refresh();
  if (saved) { mine = { name: saved.name }; if (!S.roster.some(isMine)) mine = null; }
  render(); renderBoard();

  const pending = api.loadPending();
  if (pending) {
    $("msg").style.color = 'var(--coral)';
    $("msg").innerHTML = `你有一筆 $${fmt(pending.bet)} 沒送出成功。` +
      `<button class="ghost" id="resend" style="margin-left:6px">重送</button>` +
      `<button class="ghost" id="drop">丟掉</button>`;
    $("resend").onclick = () => submitBet(pending);
    $("drop").onclick = () => { api.clearPending(); $("msg").textContent = ''; };
  }

  // 戰況頁每 30 秒同步一次。切到背景時停掉,免得手機一直耗電。
  const startPoll = () => { if (!pollTimer) pollTimer = setInterval(refresh, 30000); };
  const stopPoll = () => { clearInterval(pollTimer); pollTimer = null; };
  document.addEventListener('visibilitychange', () => document.hidden ? stopPoll() : (refresh(), startPoll()));
  startPoll();
})();
```

- [ ] **Step 4: 更新頁尾說明**

把頁尾第二行從固定的容許值改成隨當日變動：

```html
<div class="foot">
  結算 = Coinbase Exchange BTC-USD · 9/11 00:00 UTC+8 開盤價<br>
  餐點倍數 = (1 + 膽量 ÷ 10) × (1 − 誤差 ÷ 容許值)　·　容許值 = round(6 × √剩餘天數)<br>
  截止前可隨時改注,計分只看最新一筆,但每次送出都會留下紀錄。
</div>
```

- [ ] **Step 5: 填入 API 網址並在瀏覽器手動驗證**

把 `API_URL` 換成 Task 5 的部署網址。起一個本機伺服器（直接開檔案會因 `file://` 而使 fetch 失敗）：

```bash
python3 -m http.server 8000
```

開 `http://localhost:8000/`，依序確認：

1. 連線狀態列顯示「已同步 · 市價 $… · 剩 N 天 · 容許 ±M%」，數字與 `curl` 拿到的一致
2. 下注頁沒有「下注日」下拉選單
3. 戰況頁沒有「載入範例」與「清空紀錄」按鈕
4. 用「測試丙 / 1234」下注一次 → 訊息顯示「第 1 次送出」，排行榜出現該筆
5. 按鈕文字變成「改注」；改一個價再送 → 顯示「第 2 次送出」，排行榜的價格跟著變、但**只有一列**
6. Sheet 的 `bets` 有兩列，`current` 的改注次數為 1
7. 重新整理頁面 → 名字與 PIN 自動帶回，按鈕仍是「改注」
8. 把 `API_URL` 暫時改成一個不存在的網址重整 → 顯示紅字連線錯誤，且**送出按鈕仍可按**（不再像舊版那樣鎖死）；驗證完改回來

- [ ] **Step 6: 清掉測試資料並提交**

從 Sheet 的 `bets` 與 `players` 刪掉「測試丙」的列。

```bash
git add index.html
git commit -m "前端接上 Web App,改為可重複下注

移除 window.storage、寫死的 PATH/DL 表與下注日下拉選單——
日期與市價改由伺服器蓋章,玩家不能自選。

移除「清空紀錄」按鈕:它讓任何人一鍵刪掉全場所有人的下注,
在共用儲存下已是實際存在的漏洞。

送出失敗不再鎖死輸入框。舊版失敗時按鈕與輸入全部 disabled,
玩家完全無法重試;現在改為保留輸入、放開按鈕、提供重送。

散點圖橫軸改用真實時間戳定位,不再依賴寫死的日期索引。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: 走勢圖接真實 K 線與降級

`drawScatter` 已預留 `klines` 的繪製分支，這一步只需把資料填進去。

**Files:**
- Modify: `index.html`

**Interfaces:**
- Consumes: Task 8 的 `klines` 變數與 `drawScatter`
- Produces: `loadKlines() => Promise<void>`，成功時 `klines` 為 `Array<{t: number, close: number}>`

- [ ] **Step 1: 加入 K 線擷取**

在 `index.html` 的 `boot()` 之前插入：

```js
// 歷史走勢直接向 Coinbase Exchange 取。這是唯讀公開資料,不影響計分,
// 因此可以由前端抓;計分用的市價一律走伺服器。
async function loadKlines(){
  try {
    // granularity 單位是秒,86400 = 日線。
    const res = await fetch('https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const raw = await res.json();
    if (!Array.isArray(raw) || !raw.length) throw new Error('回應格式不對');
    // Coinbase 回 [time, low, high, open, close, volume],有兩點與 Binance 相反:
    //   1. time 的單位是「秒」不是毫秒 → 要乘 1000
    //   2. 排列是新到舊 → 畫折線前必須依時間升冪重排,否則線會來回折疊
    // close 剛好兩家都在索引 4。
    klines = raw
      .map(k => ({ t: Number(k[0]) * 1000, close: Number(k[4]) }))
      .filter(k => isFinite(k.t) && isFinite(k.close) && k.close > 0 && k.t >= T0)
      .sort((a, b) => a.t - b.t);
  } catch (err) {
    // 抓不到就不畫走勢線,其餘功能照常。
    klines = [];
    console.warn('走勢圖資料抓不到:', err.message);
  }
}
```

- [ ] **Step 2: 在啟動流程中呼叫**

把 `boot()` 裡的這一行：

```js
  await refresh();
```

改成：

```js
  await Promise.all([refresh(), loadKlines()]);
```

`Promise.all` 讓兩個請求並行；`loadKlines` 內部自行吞掉錯誤，所以不會讓 `refresh` 一起失敗。

- [ ] **Step 3: 在瀏覽器驗證**

重整 `http://localhost:8000/`：

1. 戰況頁的散點圖出現一條青色 BTC 走勢線，右端價格與狀態列的市價接近
2. 開發者工具的 Network 應看到一筆 `candles` 請求，狀態 200。
   **若是 CORS 錯誤**（Console 出現 `blocked by CORS policy`），代表前端不能直連，
   改為在 `Code.gs` 加一個回傳日線的端點由伺服器代取——不要為此放棄降級行為
3. 走勢線的時間方向必須由左到右遞增。若線條來回折疊，代表忘了依時間升冪重排
4. 在 Network 分頁把 `api.exchange.coinbase.com` 加入封鎖清單後重整 → 走勢線消失，
   但排行榜、下注、狀態列全部照常運作，Console 有一行 `走勢圖資料抓不到` 警告

第 3 點是這個任務的重點：被封鎖的地區不能因為畫不出走勢線就整頁掛掉。

- [ ] **Step 4: 提交**

```bash
git add index.html
git commit -m "走勢圖改用真實 K 線並加上降級

歷史走勢是唯讀公開資料、不影響計分,所以由前端直接向 Coinbase Exchange 取;
計分用的市價仍一律走伺服器端。

Coinbase 的 candles 與 Binance 的 klines 有兩點相反:時間單位是秒而非毫秒,
且排列為新到舊。兩者都要轉換,否則走勢線會畫在錯誤位置或來回折疊。

抓不到時只是不畫走勢線,排行榜與下注功能照常——
不能因為畫不出圖就整頁掛掉。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: 端到端驗收與開賽前清場

**Files:**
- Modify: `README.md`
- Create: `docs/playbook.md`

**Interfaces:**
- Consumes: 前九個任務的全部產出
- Produces: 可開賽的系統與一份主辦操作手冊

- [ ] **Step 1: 跑完整測試**

```bash
node --test
```

預期：`# pass 28` / `# fail 0`。任何一題 fail 都不得進入下一步。

- [ ] **Step 2: 兩人並行的端到端演練**

開兩個**不同的**瀏覽器（或一般視窗＋無痕視窗，必須是不同的 `localStorage`），都連到 `http://localhost:8000/`。

| # | 操作 | 預期 |
|---|---|---|
| 1 | A 視窗用「甲 / 1111」押 80000 | 顯示第 1 次送出 |
| 2 | B 視窗用「乙 / 2222」押 86000 | 顯示第 1 次送出 |
| 3 | B 視窗重整，等 30 秒 | 排行榜自動出現甲與乙兩人 |
| 4 | A 視窗改押 84000，再改 82000 | 兩次都顯示遞增的送出次數 |
| 5 | 查看 `bets` 分頁 | 甲三列（seq 1/2/3）、乙一列 |
| 6 | 查看 `current` 分頁 | 兩列；甲的最新預測 82000、改注次數 2、乙的改注次數 0 |
| 7 | B 視窗改用「甲 / 9999」送出 | 紅字「這個名字已經有人用了，PIN 不對」，`bets` 不增列 |
| 8 | A 視窗連按送出鍵三下 | `bets` 最多增加一列（冪等生效） |
| 9 | 兩個視窗同時按送出 | 兩列都寫進去且 `seq` 不重複（鎖生效） |
| 10 | 拉戰況頁的假設結算價滑桿 | 排行榜即時重排，主辦盈虧跟著變號 |

第 8 與第 9 項是這次驗收的重點：前者驗冪等，後者驗 `LockService`。若第 9 項出現重複的 `seq`，代表鎖沒生效，回頭檢查 `doPost` 的 `lock.waitLock` 是否包住了整段。

- [ ] **Step 3: 開賽前清場**

從 `bets` 與 `players` 刪掉演練產生的全部列（只留第 1 列表頭），並把 `current!B1` 清空。

這是 `bets` 最後一次允許手動刪列。開賽後它必須維持純 append-only，否則改注歷程就不可信了。

- [ ] **Step 4: 部署到靜態主機**

推上 GitHub Pages 或 Netlify。

若用 GitHub Pages 且 repo 為 public，`index.html` 裡的 `API_URL` 等於公開——任何人都能打 `doGet` 看到全場下注。這不會讓人改到別人的注（有 PIN 擋著），但**密封性會消失**。若在意這點，改用 Netlify 私有部署，或接受公開並在群組事先講明。

- [ ] **Step 5: 寫主辦操作手冊**

建立 `docs/playbook.md`：

```markdown
# 主辦操作手冊

## 開賽前
- [ ] `bets` 與 `players` 只剩表頭
- [ ] `current!B1` 清空
- [ ] `index.html` 的 `TARGET` 改成實際報名人數（目前預設 25）
- [ ] 在群組公告：結算價定義、截止時間、改注規則、PIN 要自己記牢

## 賽中
每天看一次 `current`，把排行榜截圖丟群組。
`bets` 分頁是完整的改注歷程，只有你看得到——賽後公布會很有戲。

若某列的 `src` 是 `fallback`，代表當下行情 API 抓不到、用了前一筆市價。
偶爾一兩筆無妨；若連續出現，檢查 Apps Script 的執行記錄。

## 9/11 結算
1. 取 Coinbase Exchange BTC-USD 9/11 00:00 (UTC+8) 的開盤價
2. 填進 `current!B1`
3. 倍數欄即為每人的餐點份數

總支出通常落在 11 至 13 份（期望值約 0.7 至 0.9），差額是主辦方的緩衝。
若要帳剛好平，另外加一欄 `= 人數 × 個人倍數 ÷ 全體倍數總和`，
但那會變成零和，成績受同場對手影響。

## 出事時
- 玩家說改不了注 → 多半是 PIN 忘了。查 `players` 確認名字，請他換個名字重下，
  或你直接在 `bets` 補一列（記得 `seq` 要接續）
- 伺服器沒反應 → Apps Script 編輯器看「執行項目」的錯誤記錄
- 改了程式碼沒生效 → 你八成只按了儲存。要「管理部署作業 → 編輯 → 新版本」
```

- [ ] **Step 6: 補完 README 並提交**

在 `README.md` 檔尾追加：

```markdown
## 檔案結構

| 檔案 | 職責 |
|---|---|
| `src/lib.js` | 純函式：計分、時間換算、流水帳聚合。Node / Apps Script / 瀏覽器三邊共用 |
| `src/Code.gs` | Apps Script：HTTP 進出、Sheet 讀寫、行情擷取 |
| `src/api.js` | 前端 API client |
| `index.html` | 頁面 |
| `tools/build-gas.sh` | 打包成單一 .gs 供貼進 Apps Script |
| `docs/sheet-setup.md` | Sheet 結構與 current 公式 |
| `docs/playbook.md` | 主辦操作手冊 |

邏輯集中在 `src/lib.js`、`Code.gs` 只留 I/O，是為了讓計分能用
`node --test` 測到——Apps Script 本身難以自動化測試。

`node --test` 不加參數即可，Node 會自行掃出 `test/**/*.test.js`。
不要寫成 `node --test test/`：Node 26 會把 `test` 當成模組去載入而報
`Cannot find module`。
```

```bash
git add README.md docs/playbook.md
git commit -m "補上端到端驗收後的操作手冊與檔案結構說明

playbook 收錄開賽前清場、賽中巡檢與結算三段流程,
並記下最常見的三個故障:PIN 忘記、Apps Script 執行錯誤、
以及改了程式碼卻只按儲存導致沒生效。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```
