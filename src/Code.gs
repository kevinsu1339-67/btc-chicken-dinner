// ====== Apps Script 層：只做 I/O 與組裝，邏輯一律放 lib.js ======

const SHEET_ID = '1j3ZR5aMRWtVA2ILoydljTk1UjQ61qCn7KDPSqlOjha0';  // docs/sheet-setup.md
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

// 市價擷取。快取 30 秒，避免每次點擊都打一次 Coinbase Exchange。
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
    // 本端點為公開無認證 API，故錯誤詳情不可洩露至外部呼叫者。
    // 完整錯誤已記錄於 Cloud Logging，Sheet 擁有者可據以偵錯。
    console.error('doGet 拋出例外', err);
    return json_({ ok: false, reason: 'server_error', message: '伺服器暫時無法使用，請稍後再試' });
  }
}

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
    console.error('doPost 拋出例外', err);
    return json_({ ok: false, reason: 'server_error', message: '伺服器暫時無法使用，請稍後再試' });
  } finally {
    lock.releaseLock();
  }
}
