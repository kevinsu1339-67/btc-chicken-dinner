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
