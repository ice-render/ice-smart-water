#!/usr/bin/env bash
# 双远端推送（家族固定流程）：先合并 dev → master，再推 gitee（origin）+ github（origin-github，需走 Clash）
# 用法：bash scripts/dual-push.sh
set -e
cd "$(dirname "$0")/.."

branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" != "dev" ]; then
  echo "当前在 $branch，先切回 dev 开发（推送前合并到 master 由本脚本负责）"
  exit 1
fi

echo "== 1/3 dev → master =="
git checkout master
git merge --no-ff dev -m "chore: merge dev（$branch → master）"
git checkout dev

echo "== 2/3 推 gitee =="
git push origin dev
git push origin master

echo "== 3/3 推 github（走 Clash 代理）=="
git -c http.proxy=http://127.0.0.1:7890 -c https.proxy=http://127.0.0.1:7890 push origin-github dev
git -c http.proxy=http://127.0.0.1:7890 -c https.proxy=http://127.0.0.1:7890 push origin-github master

echo "== 完成：dev 与 master 已同步到双远端 =="
