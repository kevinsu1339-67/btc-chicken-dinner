'use strict';

// 結算＝下注截止，同一瞬間
const SETTLE_MS = Date.parse('2026-09-11T00:00:00+08:00');
const MS_PER_DAY = 86400000;

// 名字正規化：NFKC 讓全形轉半形，再去空白、收斂內部空白、英文轉小寫。
// 目的是讓「Ｋｅｖｉｎ」「KEVIN」「 kevin 」指向同一個 player_id。
function normalizeName(name) {
  return String(name).normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

// 這是封閉賽局唯一的 25 人名單，由主辦人核對過（正規化後彼此不衝突、
// 沒有危險的開頭字元、沒有純數字、NFKC 不會改變它、都在 20 字以內、
// 也不會撞到 Object.prototype 的既有鍵）。安全性完全來自「在不在這份
// 名單裡」，不是靠事後偵測輸入長什麼樣子——凡是 ROSTER 裡的字串，
// 寫進 Sheet 儲存格一定安全，因為每一筆都已經檢查過。
// 要新增或修改玩家，直接編輯這個陣列並重新部署，沒有其他地方要改。
const ROSTER = [
  'David', 'Justin', 'Aaron', 'Daniel', 'Emma', 'Isam', 'Jerry', 'Kate Huang',
  'Liang', 'Lin', 'Lydia', 'Mark88', 'nica', 'RM林文彬', 'Roger', 'Roman',
  'Sean', 'Simon', 'Sophia', '大衛鱸鰻', '安迪', '幸運好豪', '敦南RM黃煌堯',
  '陳小明', 'Kevin'
];

// 查找表在模組載入時建一次，而非每次呼叫 rosterIdOf 都重新正規化整份名單。
// 用 Object.create(null) 而非 {}：即使名單或輸入湊巧撞到 constructor 之類
// 的字，也不會誤取到繼承自 Object.prototype 的值。
const ROSTER_BY_NORMALIZED = Object.create(null);
for (let i = 0; i < ROSTER.length; i++) {
  ROSTER_BY_NORMALIZED[normalizeName(ROSTER[i])] = ROSTER[i];
}

// 把任意輸入正規化後拿去比對名單，命中則回傳「名單裡原本的字串」
// （不是呼叫端送來的版本），未命中回傳 null。這保證最終寫進 Sheet
// 儲存格的一定是 ROSTER 裡驗證過的那個確切字串。
function rosterIdOf(name) {
  const key = normalizeName(name);
  return (key in ROSTER_BY_NORMALIZED) ? ROSTER_BY_NORMALIZED[key] : null;
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

// bets 分頁的欄序。Code.gs 讀寫、rowToBet 解析都以此為準。
const BET_COLS = ['ts', 'player_id', 'name', 'seq', 'days_left',
                  'tol', 'mkt', 'bet', 'guts', 'src', 'nonce'];

function rowToBet(row) {
  const o = {};
  for (let i = 0; i < BET_COLS.length; i++) o[BET_COLS[i]] = row[i];
  return o;
}

// 每人只留 seq 最大的那筆。Seq 值由 doPost 寫入鎖保證唯一，故無需處理相同 seq 的情況。
function rosterFromRows(rows) {
  // Object.create(null)：純函式不該依賴呼叫端保證 player_id 不是
  // __proto__ 或 constructor 之類的鍵，否則 byPlayer[k] 會取到繼承值。
  const byPlayer = Object.create(null);
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
    // 補強而非主防線：主防線是 validateSubmission 擋掉會讓 Sheets 變型別的
    // playerId。這裡用 String() 是為了 belt-and-braces——getValues() 讀回來的
    // 儲存格可能是數字或布林，不該讓型別不同直接讓比對整組失效。
    if (r && String(r[1]) === playerId) max = Math.max(max, Number(r[3]) || 0);
  }
  return max + 1;
}

// 冪等檢查：雙擊或網路重試會用同一個 nonce 送兩次，只能寫一列。
// 全掃所有列而非提前中止，因列順序無法保證與時間順序相同；Sheet 小（25人×若干筆），成本低。
function hasRecentNonce(rows, nonce, nowMs, windowMs) {
  const w = (windowMs === undefined) ? 60000 : windowMs;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (!r) continue;
    const t = Date.parse(r[0]);
    // 若時間無法解析則保守視為窗內；否則檢查是否在時間窗內。
    // r[10] 用 String() 是補強而非主防線：主防線是 validateSubmission 擋掉
    // 會讓 Sheets 變型別的 nonce，這裡只是防 getValues() 讀回數字時整組失效。
    if ((isNaN(t) || nowMs - t <= w) && String(r[10]) === nonce) return true;
  }
  return false;
}

// 行情 API 回應解析。預期 ticker 回應有頂層 price 欄位。被限流或地區封鎖時回的是 HTML 而非 JSON，
// 因此必須丟例外讓上層走 fallback，絕不能回 NaN。
function parseTickerPrice(text) {
  const o = JSON.parse(text);
  const p = Number(o.price);
  if (!isFinite(p) || p <= 0) throw new Error('Ticker 回應沒有可用的價格：' + text.slice(0, 120));
  return p;
}

// 判斷字串經 appendRow 寫入 Sheet 儲存格後，getValues() 讀回來會不會變型別。
// appendRow 是「使用者輸入」語意的寫入：儲存格裡打「123」會被存成數字 123，
// 打「true」會變成布林 TRUE，打「1/2」或「2026-09-11」會被解析成日期，
// 開頭打「'」則是 Sheets 的強制文字標記，字元本身會被吃掉。
// 這些情況下，寫入前算好的字串就再也無法用 === 比對回讀出來的儲存格值。
//
// name／playerId 已經不再需要這一關：兩者現在只能是 ROSTER 裡驗證過的
// 25 個固定字串之一（見 rosterIdOf），值的集合有限且已在撰寫時逐一驗證
// 過不會被 Sheets 轉型，不必再靠這個函式事後猜。這個函式現在只剩下
// 一個呼叫者——nonce 是客戶端自產生的任意字串，不在白名單內，仍然需要
// 這一關才能保證 hasRecentNonce 的 === 比對成立。
function breaksSheetRoundTrip(s) {
  if (s.charAt(0) === "'") return true; // 強制文字標記，字元會被吃掉
  if (s.trim() !== '' && isFinite(Number(s))) return true; // 數字外觀，如 123／0012／1e5
  if (/^(true|false)$/i.test(s)) return true; // 布林外觀
  if (/[/\\]/.test(s)) return true; // 斜線，Sheets 常解析成日期
  if (/^\d+([-.:]\d+)+$/.test(s)) return true; // 數字加 - . : 分隔，日期或時間外觀
  return false;
}

// 表單驗證與清理。doPost 的第一道防線。
// name 的安全性不再靠事後偵測輸入格式，而是靠白名單：這是 25 人的封閉
// 賽局，合法玩家的集合有限且已知，membership in ROSTER 直接取代了公式
// 開頭字元／控制字元／長度／往返型別等一整組啟發式檢查——凡是 ROSTER
// 裡的字串，撰寫時已經驗證過安全，不需要再猜 Google Sheets 的剖析器
// 會怎麼處理它。
// rosterIdOf 回傳的是 ROSTER 裡「原本的」字串，不是呼叫端送來的版本，
// 所以最終寫進 bets!C 與 players!B 的一定是驗證過的那個確切值；
// 真正寫進 bets!B 與 players!A 的 player_id，則是對這個標準化後的名字
// 套用 normalizeName 算出來的，同樣不是呼叫端能左右的值。
// 依序檢查，回傳第一個失敗的原因；全部通過才回傳清理過（trim／型別轉換）後的值。
function validateSubmission(body) {
  const b = (body && typeof body === 'object') ? body : {};

  const name = rosterIdOf(b.name == null ? '' : b.name);
  if (name === null) {
    return {
      ok: false,
      reason: 'bad_name',
      message: '這個名字不在名單上，請聯絡主辦人確認你的名字。'
    };
  }
  const playerId = normalizeName(name);

  const pin = String(b.pin == null ? '' : b.pin).trim();
  if (!/^\d{4}$/.test(pin)) {
    return { ok: false, reason: 'bad_pin', message: 'PIN 必須是 4 位數字。' };
  }

  const bet = Number(b.bet);
  if (!isFinite(bet) || bet <= 0 || bet >= 1e9) {
    return { ok: false, reason: 'bad_bet', message: '預測價不正確。' };
  }

  const nonce = String(b.nonce == null ? '' : b.nonce);
  if (!nonce) {
    return { ok: false, reason: 'bad_nonce', message: '缺少 nonce。' };
  }
  // nonce 也會原封不動寫進 bets!K，同樣要擋公式開頭字元。原本的字元集正規表達式
  // 只擋非法字元，不管位置，所以「-A2」「-1-1」「--x」這種開頭是 - 的合法字元
  // 組合會通過，寫進儲存格卻被 Sheets 當成公式。
  if (/^[=+\-@]/.test(nonce)) {
    return { ok: false, reason: 'bad_nonce', message: 'nonce 不能以 =、+、-、@ 開頭。' };
  }
  if (nonce.length > 64 || !/^[A-Za-z0-9_-]+$/.test(nonce)) {
    return { ok: false, reason: 'bad_nonce', message: 'nonce 格式不正確。' };
  }
  // nonce 同樣要能原樣往返 Sheet 儲存格：hasRecentNonce 也是靠 === 比對，
  // 純數字的 nonce（例如「12345」）寫進去會變成數字，讀回來就不再等於
  // 原本的字串，冪等檢查因此失效，雙擊或網路重試會被當成兩筆不同的下注。
  if (breaksSheetRoundTrip(nonce)) {
    return { ok: false, reason: 'bad_nonce', message: 'nonce 格式不正確。' };
  }

  return { ok: true, name, playerId, pin, bet, nonce };
}

// 檔尾匯出。Apps Script 沒有 module，typeof 檢查讓這段在 GAS 被安靜略過。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SETTLE_MS, MS_PER_DAY, BET_COLS, ROSTER,
    normalizeName, rosterIdOf, daysLeftFrom, tolFor, gutsOf, multOf, isClosed,
    rowToBet, rosterFromRows, nextSeq, hasRecentNonce,
    parseTickerPrice, validateSubmission
  };
}
