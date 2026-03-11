#!/usr/bin/env bash
# 监听 api-usage-console.js 变更，自动重启控制台
# 用法: ./dev-watch.sh

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONSOLE_JS="$SCRIPT_DIR/api-usage-console.js"
SERVICE_SH="$SCRIPT_DIR/service.sh"

red() { echo -e "\033[31m$*\033[0m"; }
green() { echo -e "\033[32m$*\033[0m"; }
yellow() { echo -e "\033[33m$*\033[0m"; }
muted() { echo -e "\033[90m$*\033[0m"; }

do_restart() {
  echo ""
  yellow "  [$(date '+%H:%M:%S')] 检测到变更，正在重启..."
  "$SERVICE_SH" restart
  green "  [$(date '+%H:%M:%S')] 重启完成"
  echo ""
}

echo ""
echo "  🦞 开发模式：监听 $CONSOLE_JS"
echo "  $(muted '修改文件后自动重启，按 Ctrl+C 退出')"
echo ""

if command -v fswatch >/dev/null 2>&1; then
  fswatch -o "$CONSOLE_JS" | while read -r; do
    do_restart
  done
elif command -v node >/dev/null 2>&1; then
  node -e "
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const file = process.argv[2];
const scriptDir = process.argv[3];
const base = path.basename(file);
let debounce;
fs.watch(path.dirname(file), { persistent: true }, (e, name) => {
  if (name && name !== base) return;
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    try {
      console.log('');
      console.log('  \\x1b[33m[' + new Date().toLocaleTimeString() + '] 检测到变更，正在重启...\\x1b[0m');
      execSync('./service.sh restart', { cwd: scriptDir, stdio: 'inherit' });
      console.log('  \\x1b[32m[' + new Date().toLocaleTimeString() + '] 重启完成\\x1b[0m');
      console.log('');
    } catch (e) {}
  }, 400);
});
console.log('  [Node watch] 监听 ' + base + ' ...');
process.stdin.resume();
" "$CONSOLE_JS" "$SCRIPT_DIR"
else
  red "  错误: 需要 fswatch 或 node。安装 fswatch: brew install fswatch"
  exit 1
fi
