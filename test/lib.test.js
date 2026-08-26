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

test('hasRecentNonce 必須掃描所有列，即使列順序反向', () => {
  const now = Date.parse('2026-09-02T21:47:35+08:00');
  // 反向時間排序：最新的列在前，最舊的列在後
  const reversed = [
    row('2026-09-02T21:47:05+08:00', '玩1', '玩1', 1, 9, 18, 79615, 82000, 2.99, 'n_newer'),
    row('2026-08-26T10:00:00+08:00', '玩2', '玩2', 1, 15, 23, 79200, 78000, 1.52, 'n_old'),
  ];
  // n_newer 在時間窗內（30秒），應該被找到，即使最後一列極為老舊
  assert.strictEqual(lib.hasRecentNonce(reversed, 'n_newer', now), true);
});

// --- validateSubmission：表單驗證與清理 ---
test('validateSubmission 正常送出，回傳清理過的值（canonical 名字）', () => {
  const r = lib.validateSubmission({ name: '  Kevin  ', pin: '1234', bet: '85000', nonce: 'abc-123' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.name, 'Kevin');
  assert.strictEqual(r.pin, '1234');
  assert.strictEqual(r.bet, 85000);
  assert.strictEqual(typeof r.bet, 'number');
  assert.strictEqual(r.nonce, 'abc-123');
});

test('validateSubmission 拒絕 3 位數與 5 位數的 PIN', () => {
  const short = lib.validateSubmission({ name: 'Kevin', pin: '123', bet: 1, nonce: 'n1' });
  assert.strictEqual(short.ok, false);
  assert.strictEqual(short.reason, 'bad_pin');
  const long = lib.validateSubmission({ name: 'Kevin', pin: '12345', bet: 1, nonce: 'n1' });
  assert.strictEqual(long.ok, false);
  assert.strictEqual(long.reason, 'bad_pin');
});

test('validateSubmission 拒絕非數字 PIN', () => {
  const r = lib.validateSubmission({ name: 'Kevin', pin: 'abcd', bet: 1, nonce: 'n1' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'bad_pin');
});

test('validateSubmission 拒絕 0、負數、NaN、Infinity 與 1e9 的 bet', () => {
  [0, -1, NaN, Infinity, 1e9].forEach((bet) => {
    const r = lib.validateSubmission({ name: 'Kevin', pin: '1234', bet, nonce: 'n1' });
    assert.strictEqual(r.ok, false, 'bet=' + bet + ' 應該被拒絕');
    assert.strictEqual(r.reason, 'bad_bet');
  });
});

test('validateSubmission 拒絕含空白或引號的 nonce', () => {
  const withSpace = lib.validateSubmission({ name: 'Kevin', pin: '1234', bet: 1, nonce: 'has space' });
  assert.strictEqual(withSpace.ok, false);
  assert.strictEqual(withSpace.reason, 'bad_nonce');
  const withQuote = lib.validateSubmission({ name: 'Kevin', pin: '1234', bet: 1, nonce: 'has"quote' });
  assert.strictEqual(withQuote.ok, false);
  assert.strictEqual(withQuote.reason, 'bad_nonce');
});

test('validateSubmission 拒絕超過 64 字元的 nonce', () => {
  const r = lib.validateSubmission({ name: 'Kevin', pin: '1234', bet: 1, nonce: 'n'.repeat(65) });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'bad_nonce');
});

test('validateSubmission 對 null body 回傳失敗而不拋例外', () => {
  assert.doesNotThrow(() => {
    const r = lib.validateSubmission(null);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'bad_name');
  });
});

// --- ROSTER／rosterIdOf：白名單取代原本一整組啟發式檢查 ---
test('ROSTER 剛好 25 個名字，正規化後彼此不重複', () => {
  assert.strictEqual(lib.ROSTER.length, 25);
  const normalized = lib.ROSTER.map(lib.normalizeName);
  assert.strictEqual(new Set(normalized).size, 25);
});

test('rosterIdOf 忽略大小寫與全形半形，一律解析回同一個 canonical 名字', () => {
  ['kevin', 'KEVIN', 'Ｋｅｖｉｎ', '  Kevin  '].forEach((input) => {
    assert.strictEqual(lib.rosterIdOf(input), 'Kevin', JSON.stringify(input) + ' 應該解析成 Kevin');
  });
});

test('rosterIdOf 對不在名單上的輸入回傳 null', () => {
  assert.strictEqual(lib.rosterIdOf('Mallory'), null);
  assert.strictEqual(lib.rosterIdOf(''), null);
  assert.strictEqual(lib.rosterIdOf(null), null);
});

test('validateSubmission 拒絕不在名單上的名字', () => {
  const r = lib.validateSubmission({ name: 'Mallory', pin: '1234', bet: 1, nonce: 'n1' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'bad_name');
});

test('validateSubmission 回傳的是 canonical 名字，不是呼叫端送來的大小寫版本', () => {
  const r = lib.validateSubmission({ name: 'mark88', pin: '1234', bet: 1, nonce: 'n1' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.name, 'Mark88');
  assert.strictEqual(r.playerId, lib.normalizeName('Mark88'));
});

test('ROSTER 裡每一個名字都能通過 validateSubmission，且 playerId 不是空的、不以公式字元開頭', () => {
  lib.ROSTER.forEach((name) => {
    const r = lib.validateSubmission({ name, pin: '1234', bet: 1, nonce: 'n1' });
    assert.strictEqual(r.ok, true, JSON.stringify(name) + ' 應該通過');
    assert.ok(r.playerId.length > 0, JSON.stringify(name) + ' 的 playerId 不該是空的');
    assert.ok(!/^[=+\-@']/.test(r.playerId), JSON.stringify(name) + ' 的 playerId 不該以公式字元開頭：' + r.playerId);
  });
});

// 這些輸入曾經需要靠 breaksSheetRoundTrip／Number() 之類的啟發式一一擋下，
// 白名單上路後它們全都不在 ROSTER 裡，單靠 membership 檢查就會被拒絕，
// 不必再猜 Google Sheets 的 USER_ENTERED 剖析器認不認得這些格式。
test('先前需要靠啟發式擋下的輸入，現在單靠不在名單上就被拒絕', () => {
  const attacks = ['1,234', '$5', '50%', '(7)', 'jan 5', '12pm', '123', "'kevin", '＝1'];
  attacks.forEach((bad) => {
    const r = lib.validateSubmission({ name: bad, pin: '1234', bet: 1, nonce: 'n1' });
    assert.strictEqual(r.ok, false, JSON.stringify(bad) + ' 應該被拒絕');
    assert.strictEqual(r.reason, 'bad_name', JSON.stringify(bad) + ' 應該回傳 bad_name');
  });
});

test('validateSubmission 拒絕會在 Sheet 儲存格變型別的 nonce（破壞冪等）', () => {
  const cases = ['-A2', '-1-1', '--x', '12345', '=1'];
  cases.forEach((nonce) => {
    const r = lib.validateSubmission({ name: 'Kevin', pin: '1234', bet: 1, nonce });
    assert.strictEqual(r.ok, false, JSON.stringify(nonce) + ' 應該被拒絕');
    assert.strictEqual(r.reason, 'bad_nonce', JSON.stringify(nonce) + ' 應該回傳 bad_nonce');
  });
});

// --- rosterFromRows 對任意 player_id 的防護，不依賴呼叫端保證 ---
test('rosterFromRows 遇到 player_id 為 __proto__ 的列，仍正確算出 1 筆', () => {
  const rows = [
    row('2026-08-26T14:03:11+08:00', '__proto__', 'Kevin', 1, 16, 24, 78412, 85000, 8.40, 'n1'),
  ];
  const r = lib.rosterFromRows(rows);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].name, 'Kevin');
});

// --- 讀取端防禦：getValues() 可能回傳數字或布林，不應該讓比對整組失效 ---
test('nextSeq 在 player_id 讀回是數字時仍能算出正確序號', () => {
  const rows = [
    row('2026-08-26T14:03:11+08:00', 123, '123', 1, 16, 24, 78412, 85000, 8.40, 'n1'),
    row('2026-08-27T10:00:00+08:00', 123, '123', 2, 15, 23, 79200, 78000, 1.52, 'n2'),
  ];
  assert.strictEqual(lib.nextSeq(rows, '123'), 3);
});

test('hasRecentNonce 在 nonce 讀回是數字時仍能比對到', () => {
  const now = Date.parse('2026-09-02T21:47:35+08:00');
  const rows = [
    row('2026-09-02T21:47:05+08:00', '阿明', '阿明', 1, 9, 18, 79615, 82000, 2.99, 12345),
  ];
  assert.strictEqual(lib.hasRecentNonce(rows, '12345', now), true);
});

// --- 行情 API 回應解析 ---
test('parseTickerPrice 取出價格並轉成 number（Coinbase Exchange）', () => {
  assert.strictEqual(
    lib.parseTickerPrice('{"ask":"79131.72","bid":"79131.71","volume":"8399.11957497","trade_id":1083309461,"price":"79131.71","size":"0.00000007","time":"2026-08-26T06:01:10.3Z"}'),
    79131.71
  );
});

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
