// ============================================================
//  比特幣預測賽 — Sheet 一鍵建置
//
//  用法：
//    1. 新建一份空白 Google 試算表
//    2. 選「擴充功能 → Apps Script」
//    3. 把這整個檔案貼進 Code.gs，取代全部原有內容
//    4. 上方函式選單選 setupSheet，按「執行」（首次會要求授權）
//    5. 看「執行記錄」，把印出來的 Sheet ID 交給 Claude
//
//  這支腳本可重複執行：它會清空並重建三個分頁，不會累積髒資料。
//  驗證用的假資料在 Task 10 開賽前清場時刪除。
// ============================================================

const BET_HEADERS = ['ts', 'player_id', 'name', 'seq', 'days_left',
                     'tol', 'mkt', 'bet', 'guts', 'src', 'nonce'];
const PLAYER_HEADERS = ['player_id', 'name', 'pin_hash', 'first_ts'];

const SETTLE_MS = Date.parse('2026-09-11T00:00:00+08:00');
const TEST_SETTLE = 82400;   // current!B1 的驗證用結算價
const LAST_ROW = 55;         // 公式填到第 55 列，可容納 50 人

// 驗證用假資料。只給「事實」欄位，guts / days_left / tol 一律由公式算出來,
// 避免手寫的衍生值與事實欄位對不起來。
const SAMPLE = [
  { ts: '2026-08-26T14:03:11+08:00', player: 'Kevin', seq: 1, mkt: 78412, bet: 85000, nonce: 'n1' },
  { ts: '2026-08-27T10:00:00+08:00', player: 'Emma', seq: 1, mkt: 79200, bet: 78000, nonce: 'n2' },
  { ts: '2026-09-02T21:47:05+08:00', player: 'Kevin', seq: 2, mkt: 79615, bet: 82000, nonce: 'n3' }
];

// 與 src/lib.js 完全相同的三條公式。這裡重複一份是刻意的：
// 這支腳本要能獨立貼進一份全新的試算表執行，不能依賴 lib.js 已經存在。
function daysLeftFrom_(tsMs) { return Math.max(1, Math.ceil((SETTLE_MS - tsMs) / 86400000)); }
function tolFor_(d) { return Math.round(6 * Math.sqrt(d)); }
function gutsOf_(bet, mkt) { return Math.abs(bet - mkt) / mkt * 100; }
function multOf_(bet, mkt, settle, tol) {
  const e = Math.abs(bet - settle) / settle * 100;
  return Math.max(0, (1 + gutsOf_(bet, mkt) / 10) * (1 - e / tol));
}

function setupSheet() {
  const ss = SpreadsheetApp.getActive();

  const bets = resetSheet_(ss, 'bets');
  const players = resetSheet_(ss, 'players');
  const current = resetSheet_(ss, 'current');

  buildBets_(bets);
  buildPlayers_(players);
  buildCurrent_(current);

  removeDefaultSheet_(ss);
  SpreadsheetApp.flush();

  const report = verify_(current);

  Logger.log('==================================================');
  Logger.log('Sheet ID: %s', ss.getId());
  Logger.log('==================================================');
  report.forEach((line) => Logger.log(line));
}

function resetSheet_(ss, name) {
  let sh = ss.getSheetByName(name);
  if (sh) sh.clear();
  else sh = ss.insertSheet(name);
  return sh;
}

// 預設的「工作表1 / Sheet1」在三個分頁都建好之後才刪，
// 否則刪到只剩零個分頁會丟例外。
function removeDefaultSheet_(ss) {
  ['工作表1', 'Sheet1', 'シート1'].forEach((n) => {
    const sh = ss.getSheetByName(n);
    if (sh && ss.getSheets().length > 1) ss.deleteSheet(sh);
  });
}

function buildBets_(sh) {
  sh.getRange(1, 1, 1, BET_HEADERS.length).setValues([BET_HEADERS]).setFontWeight('bold');

  // ts / player_id / name / src / nonce 強制為純文字。
  // 這一步是必要的：Apps Script 寫入的 ts 是 ISO 8601 字串,若讓 Sheets
  // 自動判斷型別會被轉成 Date,那麼 lib.js 的 Date.parse(r[0]) 收到的
  // 就是 Date 物件而非字串,回傳 NaN,hasRecentNonce 的時間窗會整個失效。
  // nonce 也一樣:像 '1e5' 這種值不設文字會被當成數字 100000。
  //
  // 整欄套用（getMaxRows，而非算好的列數上限）：25 人反覆改注,bets 列數
  // 會持續成長,超出原本估的上限就會寫到沒設格式的儲存格。
  // 這只是縱深防禦的一層,不是防公式注入的真正機制——真正擋公式注入的是
  // src/lib.js 的 validateSubmission（禁止 name／nonce 以 =／+／-／@ 開頭）,
  // 不能只靠儲存格格式來阻止公式被求值。
  [1, 2, 3, 10, 11].forEach((c) => sh.getRange(1, c, sh.getMaxRows()).setNumberFormat('@'));

  const rows = SAMPLE.map((s) => {
    const dl = daysLeftFrom_(Date.parse(s.ts));
    return [s.ts, s.player, s.player, s.seq, dl, tolFor_(dl),
            s.mkt, s.bet, gutsOf_(s.bet, s.mkt), 'live', s.nonce];
  });
  sh.getRange(2, 1, rows.length, BET_HEADERS.length).setValues(rows);
  sh.setFrozenRows(1);
}

function buildPlayers_(sh) {
  sh.getRange(1, 1, 1, PLAYER_HEADERS.length).setValues([PLAYER_HEADERS]).setFontWeight('bold');
  // 同 buildBets_：整欄套用純文字格式，且僅為縱深防禦，
  // 真正擋公式注入的是 src/lib.js 的 validateSubmission。
  sh.getRange(1, 1, sh.getMaxRows(), PLAYER_HEADERS.length).setNumberFormat('@');
  sh.setFrozenRows(1);
}

function buildCurrent_(sh) {
  sh.getRange('A1').setValue('結算價（9/11 開盤）');
  sh.getRange('B1').setValue(TEST_SETTLE).setNumberFormat('#,##0');
  sh.getRange('A1:B1').setFontWeight('bold');

  sh.getRange(3, 1, 1, 10).setValues([[
    'player_id', '名字', '最新預測', '最後下注時間', '容許值',
    '膽量', '誤差', '倍數', '改注次數', '首注時間'
  ]]).setFontWeight('bold');

  // XLOOKUP 的第六個參數是 search_mode：
  //   -1 = 由最後一列往回找 → 天然取到最新一筆
  //    1 = 由第一列往下找   → 天然取到首注
  // 第四個參數明確傳 "" 而不是留空,留空在部分地區設定下會被視為引數不足。
  //
  // 首注時間刻意用 XLOOKUP 而非 MINIFS：ts 欄是純文字（見 buildBets_ 的說明），
  // MINIFS 只對數值有效,套在文字欄上會回 0。
  const last = (col) => '=IF($A4="","",XLOOKUP($A4, bets!$B$2:$B, bets!$' +
                        col + '$2:$' + col + ', "", 0, -1))';
  sh.getRange('A4').setFormula('=SORT(UNIQUE(FILTER(bets!B2:B, bets!B2:B<>"")))');
  sh.getRange('B4').setFormula(last('C'));   // 名字
  sh.getRange('C4').setFormula(last('H'));   // 最新預測 bet
  sh.getRange('D4').setFormula(last('A'));   // 最後下注時間 ts
  sh.getRange('E4').setFormula(last('F'));   // 容許值 tol
  sh.getRange('F4').setFormula(last('I'));   // 膽量 guts
  sh.getRange('G4').setFormula('=IF($A4="","",ABS($C4-$B$1)/$B$1*100)');
  sh.getRange('H4').setFormula('=IF($A4="","",MAX(0,(1+$F4/10)*(1-$G4/$E4)))');
  sh.getRange('I4').setFormula('=IF($A4="","",COUNTIF(bets!$B$2:$B, $A4)-1)');
  sh.getRange('J4').setFormula('=IF($A4="","",XLOOKUP($A4, bets!$B$2:$B, bets!$A$2:$A, "", 0, 1))');

  sh.getRange('B4:J4').copyTo(sh.getRange('B5:J' + LAST_ROW));

  sh.getRange('C4:C' + LAST_ROW).setNumberFormat('#,##0');
  sh.getRange('F4:H' + LAST_ROW).setNumberFormat('0.0000');
  sh.setFrozenRows(3);
}

// 把公式算出來的值,跟這支腳本用 JS 獨立算出來的值比對。
// 兩邊都錯成同一個數字的機率極低,所以這是有意義的交叉驗證。
function verify_(sh) {
  const out = [];
  const rows = sh.getRange(4, 1, 10, 10).getValues();
  const got = {};
  rows.forEach((r) => { if (r[0]) got[r[0]] = r; });

  const names = Object.keys(got);
  out.push('current 分頁玩家數：' + names.length + '（預期 2：Kevin、Emma）');

  const latest = {};
  SAMPLE.forEach((s) => {
    if (!latest[s.player] || s.seq > latest[s.player].seq) latest[s.player] = s;
  });

  let allOk = names.length === 2;
  Object.keys(latest).forEach((p) => {
    const s = latest[p];
    const dl = daysLeftFrom_(Date.parse(s.ts));
    const tol = tolFor_(dl);
    const expect = {
      bet: s.bet,
      tol: tol,
      guts: gutsOf_(s.bet, s.mkt),
      err: Math.abs(s.bet - TEST_SETTLE) / TEST_SETTLE * 100,
      mult: multOf_(s.bet, s.mkt, TEST_SETTLE, tol),
      changes: SAMPLE.filter((x) => x.player === p).length - 1
    };
    const r = got[p];
    if (!r) { out.push('✗ ' + p + '：current 分頁找不到這個人'); allOk = false; return; }

    const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.001;
    const checks = [
      ['最新預測', r[2], expect.bet, Number(r[2]) === expect.bet],
      ['容許值', r[4], expect.tol, Number(r[4]) === expect.tol],
      ['膽量', r[5], expect.guts.toFixed(4), near(r[5], expect.guts)],
      ['誤差', r[6], expect.err.toFixed(4), near(r[6], expect.err)],
      ['倍數', r[7], expect.mult.toFixed(4), near(r[7], expect.mult)],
      ['改注次數', r[8], expect.changes, Number(r[8]) === expect.changes]
    ];
    checks.forEach((c) => {
      out.push((c[3] ? '✓ ' : '✗ ') + p + ' ' + c[0] + '：實際 ' + c[1] + ' / 預期 ' + c[2]);
      if (!c[3]) allOk = false;
    });
    out.push('  ' + p + ' 首注時間：' + r[9]);
  });

  out.push('--------------------------------------------------');
  out.push(allOk ? '全部驗證通過。把上面的 Sheet ID 交給 Claude。'
                 : '有項目不符,請把整份執行記錄貼給 Claude。');
  return out;
}
