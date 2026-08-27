#!/usr/bin/env bash
# 把前端真正需要的檔案挑進 build/site/,供拖上 Netlify / GitHub Pages。
#
# 為什麼不直接推整個 repo：src/Code.gs 裡有 SHEET_ID,推上靜態主機會變成
# 公開可讀的 /src/Code.gs。前端不需要那個檔案,也不需要 test/、tools/、docs/。
#
# API_URL 本來就會公開——任何人打開頁面看原始碼都看得到,這無法避免,
# 靠的是伺服器端的 PIN 與白名單驗證,不是靠隱藏網址。
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=build/site
rm -rf "$OUT"
mkdir -p "$OUT/src" "$OUT/assets"

cp index.html      "$OUT/"
cp src/lib.js      "$OUT/src/"
cp src/api.js      "$OUT/src/"
cp assets/*        "$OUT/assets/"

# 保險：確認沒有把含 SHEET_ID 的檔案帶進去
if grep -rl "SHEET_ID" "$OUT" 2>/dev/null | grep -q .; then
  echo "✗ 中止：輸出目錄裡出現了 SHEET_ID" >&2
  grep -rl "SHEET_ID" "$OUT" >&2
  exit 1
fi

echo "已產生 $OUT/"
find "$OUT" -type f | sort | sed 's/^/  /'
echo
echo "總大小：$(du -sh "$OUT" | cut -f1)"
echo
echo "接下來：把 $OUT 整個資料夾拖到 https://app.netlify.com/drop"
