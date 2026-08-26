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
// 這些情況下，寫入前算好的字串就再也無法用 === 比對回讀出來的儲存格值——
// authenticate_／nextSeq／hasRecentNonce 全部靠這個 === 成立，一旦不成立，
// authenticate_ 會把「找不到既有玩家」誤判為「這是新玩家」，變成任何 PIN 都能通過。
// 因此任何要寫進儲存格、之後還要拿來做身分或冪等比對的字串（playerId、nonce），
// 都必須先過這一關，寫入前就把「回讀後型別會變」的字串擋下來。
function breaksSheetRoundTrip(s) {
  if (s.charAt(0) === "'") return true; // 強制文字標記，字元會被吃掉
  if (s.trim() !== '' && isFinite(Number(s))) return true; // 數字外觀，如 123／0012／1e5
  if (/^(true|false)$/i.test(s)) return true; // 布林外觀
  if (/[/\\]/.test(s)) return true; // 斜線，Sheets 常解析成日期
  if (/^\d+([-.:]\d+)+$/.test(s)) return true; // 數字加 - . : 分隔，日期或時間外觀
  return false;
}

// 表單驗證與清理。doPost 的第一道防線，尤其是 name／nonce：
// 兩者都會原封不動寫進 Sheet 儲存格，若允許以 =／+／-／@ 開頭，
// Google Sheets 會把它當公式求值（例如讀出 players!C 欄的 pin_hash 明碼雜湊），
// 而 doGet 又會把算出來的值當作 roster 公開回傳，等於把每個人的 PIN 雜湊送給任何人離線破解。
// 依序檢查，回傳第一個失敗的原因；全部通過才回傳清理過（trim／型別轉換）後的值。
//
// 真正寫進 bets!B 與 players!A 的不是 name，是 normalizeName(name) 算出來的
// player_id。normalizeName 會做 NFKC 正規化，把全形／相容變體字元轉成 ASCII，
// 例如全形等號 ＝（U+FF1D）或小型等號 ﹦（U+FE66）都會變成半形 =。
// 只驗證 name 擋不住這種字元：name 本身通過所有檢查，NFKC 之後才變成公式開頭。
// 因此 playerId 必須在這裡（唯一算出 player_id 的地方）算出來並套用同一組檢查，
// 讓 doPost 沒有機會拿到一個沒被驗證過的 player_id。
function validateSubmission(body) {
  const b = (body && typeof body === 'object') ? body : {};

  const name = String(b.name == null ? '' : b.name).trim();
  if (!name) {
    return { ok: false, reason: 'bad_name', message: '請填名字。' };
  }
  // 先檢查開頭字元與控制字元，長度檢查放最後：
  // 這樣一個過長的注入字串會回報「公式開頭」而不是「太長」，
  // 擁有者從執行記錄的錯誤原因就能看出攻擊者實際在嘗試什麼。
  if (/^[=+\-@]/.test(name)) {
    return { ok: false, reason: 'bad_name', message: '名字不能以 =、+、-、@ 開頭。' };
  }
  // \x00-\x1F 涵蓋 tab／換行等控制字元，\x7F 是 DEL。
  if (/[\x00-\x1F\x7F]/.test(name)) {
    return { ok: false, reason: 'bad_name', message: '名字不能包含換行或控制字元。' };
  }
  if (name.length > 20) {
    return { ok: false, reason: 'bad_name', message: '名字太長了，請控制在 20 個字以內。' };
  }

  // player_id 是實際寫進 bets!B、players!A 的值，必須套用同一組開頭字元／
  // 控制字元檢查——這才是漏洞真正需要被擋住的地方。
  // 長度也要重新檢查：NFKC 不是只會讓字元變短或不變，它可以展開。
  // 例如相容字元 ⩶（U+2A76，TRIPLE TILDE EQUAL）NFKC 正規化後會變成三個字元
  // "==="；'a' + '⩶'.repeat(19) 是 20 個原始字元（剛好卡在上面的 name 長度上限
  // 之內），NFKC 之後卻是 58 字元的 playerId。上面的 20 字限制擋不住這種放大，
  // 必須在這裡對 playerId 本身再檢查一次長度。
  const playerId = normalizeName(name);
  if (!playerId) {
    return { ok: false, reason: 'bad_name', message: '這個名字正規化後是空的，換一個名字。' };
  }
  if (/^[=+\-@]/.test(playerId)) {
    return { ok: false, reason: 'bad_name', message: '這個名字正規化後會變成公式開頭，換一個名字。' };
  }
  if (/[\x00-\x1F\x7F]/.test(playerId)) {
    return { ok: false, reason: 'bad_name', message: '這個名字正規化後含有控制字元，換一個名字。' };
  }
  if (playerId.length > 20) {
    return { ok: false, reason: 'bad_name', message: '這個名字正規化後太長了，換一個名字。' };
  }
  // 認證繞過／冒名的根本防線：playerId 必須能原樣往返 Sheet 儲存格。
  // appendRow 寫入時若被 Sheets 當成數字／布林／日期／強制文字，
  // getValues() 讀回來的型別就不再等於這裡算出的字串，authenticate_ 的
  // === 比對永遠不成立，會把「已註冊玩家」誤判成「新玩家」而略過 PIN 檢查。
  if (breaksSheetRoundTrip(playerId)) {
    return {
      ok: false,
      reason: 'bad_name',
      message: '這個名字太像純數字或符號了，Google Sheets 會把它存成別的型別。請至少加一個英文字母或中文字。'
    };
  }

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
    SETTLE_MS, MS_PER_DAY, BET_COLS,
    normalizeName, daysLeftFrom, tolFor, gutsOf, multOf, isClosed,
    rowToBet, rosterFromRows, nextSeq, hasRecentNonce,
    parseTickerPrice, validateSubmission
  };
}
