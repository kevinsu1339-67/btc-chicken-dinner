#!/usr/bin/env bash
# 把 src/lib.js 與 src/Code.gs 串成單一檔案，供貼進 Apps Script 專案。
# 兩個檔分開維護但只貼一個，避免兩邊手動同步而漂移。
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build
{
  echo "// ====== 自動產生，請勿直接編輯這個檔 ======"
  echo "// 來源：src/lib.js + src/Code.gs"
  echo "// 產生時間：$(date '+%Y-%m-%d %H:%M:%S')"
  echo
  cat src/lib.js
  echo
  cat src/Code.gs
} > build/gas-bundle.gs
echo "已產生 build/gas-bundle.gs（$(wc -l < build/gas-bundle.gs | tr -d ' ') 行）"
echo
echo "接下來："
echo "  1. 全選 build/gas-bundle.gs 的內容"
echo "  2. 貼進 Apps Script 專案的 Code.gs，取代全部原有內容"
echo "  3. 部署 → 管理部署作業 → 編輯（鉛筆）→ 版本選「新版本」→ 部署"
echo "     ※ 只按儲存不會生效，網址跑的仍是舊版程式碼"
