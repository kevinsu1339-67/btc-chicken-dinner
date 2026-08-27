// ============================================================
//  比特幣預測賽 — 清空下注紀錄（開賽前重置）
//
//  用法：
//    1. 在 Sheet 選「擴充功能 → Apps Script」
//    2. 開一個新檔（左側「檔案 +」→ 指令碼），把這整段貼進去
//       ※ 不要覆蓋掉 Code.gs，那是正式運作的程式
//       ※ 這個檔案沒有和 lib.js 重複的 const，可以與 Code.gs 並存
//    3. 函式選單選 clearBets，按「執行」
//    4. 讀「執行記錄」——它會先把要刪的每一列印出來再刪
//
//  ⚠️ 這會刪掉所有人的下注與註冊。開賽後不要跑。
//
//  刪除前的完整內容會印在執行記錄裡，等於一份備份。
//  真的刪錯了，從執行記錄把資料抄回去即可。
// ============================================================

// 設成 false 就只印出要刪的東西、不真的刪。建議第一次先這樣跑。
const CLEAR_REALLY_DELETE = true;

// 設成 false 就保留 players 分頁（大家的 PIN 註冊會留著）。
// 保留的話會出現「有 PIN 但沒有下注」的狀態，無害但不一致；
// 而且若某人的註冊是用測試 PIN 建的，本人會一直被鎖在外面。
const CLEAR_PLAYERS_TOO = true;

function clearBets() {
  const ss = SpreadsheetApp.getActive();
  Logger.log('==================================================');
  Logger.log(CLEAR_REALLY_DELETE ? '模式：實際刪除' : '模式：試跑（不會真的刪）');
  Logger.log('==================================================');

  const betsDeleted = clearTab_(ss, 'bets');
  const playersDeleted = CLEAR_PLAYERS_TOO ? clearTab_(ss, 'players') : -1;

  // current!B1 是結算價。開賽前應該是空的，結算當天才填。
  const cur = ss.getSheetByName('current');
  if (cur) {
    const b1 = cur.getRange('B1').getValue();
    Logger.log('current!B1 原本是：%s', b1 === '' ? '(空的)' : b1);
    if (CLEAR_REALLY_DELETE) cur.getRange('B1').clearContent();
  }

  Logger.log('--------------------------------------------------');
  Logger.log('bets 刪除 %s 列', betsDeleted);
  Logger.log(playersDeleted < 0 ? 'players 保留未動' : 'players 刪除 ' + playersDeleted + ' 列');
  Logger.log(CLEAR_REALLY_DELETE
    ? '完成。現在是乾淨的開賽狀態。'
    : '這是試跑，什麼都沒刪。把 CLEAR_REALLY_DELETE 改成 true 再跑一次。');
}

// 刪掉資料列但保留第 1 列表頭與整欄格式。
// 用 clearContent 而非 deleteRows：deleteRows 會把 bootstrap 設好的
// 純文字格式一起往上帶，ts 欄若失去 '@' 格式，之後寫入的 ISO 字串
// 會被 Sheets 轉成 Date，lib.js 的 Date.parse 就會回 NaN。
function clearTab_(ss, name) {
  const sh = ss.getSheetByName(name);
  if (!sh) { Logger.log('找不到分頁：%s', name); return 0; }

  const last = sh.getLastRow();
  if (last < 2) { Logger.log('%s 已經是空的', name); return 0; }

  const width = sh.getLastColumn();
  const rows = sh.getRange(2, 1, last - 1, width).getValues();

  Logger.log('--- %s 即將刪除 %s 列（以下是備份）---', name, rows.length);
  rows.forEach((r, i) => Logger.log('  [%s] %s', i + 1, r.join(' | ')));

  if (CLEAR_REALLY_DELETE) sh.getRange(2, 1, last - 1, width).clearContent();
  return rows.length;
}
