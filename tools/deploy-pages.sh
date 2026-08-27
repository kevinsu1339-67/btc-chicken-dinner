#!/usr/bin/env bash
# 把 build/site/ 發布到 gh-pages 分支,供 GitHub Pages 服務。
#
# 為什麼不直接從 main 發布：main 含 src/Code.gs(內有 SHEET_ID)、tools/、
# test/、docs/。Pages 從 main 發布會把它們全部變成可透過網址下載的檔案。
# gh-pages 分支只放 build-site.sh 挑出來的五個前端檔案。
#
# 這個分支每次都被強制覆寫,它沒有需要保留的歷史——真正的歷史在 main。
set -euo pipefail
cd "$(dirname "$0")/.."

REMOTE=$(git remote get-url origin)
BRANCH=gh-pages

./tools/build-site.sh

echo
echo "推送到 $BRANCH …"
cd build/site
rm -rf .git
git init -q
git checkout -qb "$BRANCH"
git add -A
git -c user.name="$(git -C ../.. config user.name)" \
    -c user.email="$(git -C ../.. config user.email)" \
    commit -qm "deploy $(date '+%Y-%m-%d %H:%M:%S') from $(git -C ../.. rev-parse --short HEAD)"
git push -qf "$REMOTE" "$BRANCH":"$BRANCH"
rm -rf .git

echo "完成。"
echo
echo "首次發布還要在 GitHub 開啟 Pages："
echo "  Settings → Pages → Source 選 'Deploy from a branch' → 分支選 gh-pages / (root)"
echo "  或直接跑： gh api -X POST repos/{owner}/{repo}/pages -f source[branch]=gh-pages -f source[path]=/"
