#!/bin/bash
# 把工作区里的 client.js 覆盖到 Host 正在服务的所有 generation。
#
# 为什么不是「重新 install_bundle + 刷新页面」：install_bundle 会生成新的
# 不可变 generation 目录再切 symlink，而运行中的 Host 仍在服务旧目录，所以
# 那条路必须完全退出重开。客户端 HMR 只 `stat` 它正在服务的那份文件的 mtime，
# 直接覆盖才是幂等、且 1 秒内生效的。从外部无法查询 Host 指向哪一代，全推一遍即可。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
GEN_ROOT="${DSH_HOME:-$HOME/Library/Application Support/dsh-desktop/harness}/profiles/.generations/live"
NAME="$(node -p "require('$ROOT/package.json').name")"

count=0
for dir in "$GEN_ROOT/$NAME"+*/node_modules/"$NAME"; do
  [ -d "$dir" ] || continue
  cp "$ROOT/client.js" "$dir/client.js"
  cp "$ROOT/index.js" "$dir/index.js"
  cp "$ROOT/cordis.patch.yml" "$dir/cordis.patch.yml"
  cp "$ROOT/icon.svg" "$dir/icon.svg"
  cp "$ROOT/package.json" "$dir/package.json"
  rm -rf "$dir/sfx"
  cp -R "$ROOT/sfx" "$dir/sfx"
  echo "  → $dir"
  count=$((count + 1))
done

if [ "$count" -eq 0 ]; then
  echo "没有找到已安装的 generation：先跑一次 plugin_manager install_bundle $ROOT" >&2
  exit 1
fi

echo "pushed to $count generation(s); 客户端 1 秒内生效，index.js 的改动仍需重启"
