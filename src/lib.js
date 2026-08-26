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
    if (r && r[1] === playerId) max = Math.max(max, Number(r[3]) || 0);
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
    // 若時間無法解析則保守視為窗內；否則檢查是否在時間窗內
    if ((isNaN(t) || nowMs - t <= w) && r[10] === nonce) return true;
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

// 檔尾匯出。Apps Script 沒有 module，typeof 檢查讓這段在 GAS 被安靜略過。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SETTLE_MS, MS_PER_DAY, BET_COLS,
    normalizeName, daysLeftFrom, tolFor, gutsOf, multOf, isClosed,
    rowToBet, rosterFromRows, nextSeq, hasRecentNonce,
    parseTickerPrice
  };
}
