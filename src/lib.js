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
