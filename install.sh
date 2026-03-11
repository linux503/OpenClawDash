#!/usr/bin/env bash
# OpenClaw 监控控制台 — 自动寻找目录并安装
# 用法: ./install.sh [目标目录]  或直接运行，将自动检测

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

red() { echo -e "\033[31m$*\033[0m"; }
green() { echo -e "\033[32m$*\033[0m"; }
yellow() { echo -e "\033[33m$*\033[0m"; }
muted() { echo -e "\033[90m$*\033[0m"; }
cyan() { echo -e "\033[36m$*\033[0m"; }

# 自动寻找 OpenClaw 数据目录
find_openclaw_dir() {
  # 1. 环境变量
  if [[ -n "$OPENCLAW_STATE_DIR" && -d "$OPENCLAW_STATE_DIR" ]]; then
    echo "$(cd "$OPENCLAW_STATE_DIR" && pwd)"
    return
  fi
  if [[ -n "$OPENCLAW_HOME" && -d "$OPENCLAW_HOME" ]]; then
    echo "$(cd "$OPENCLAW_HOME" && pwd)"
    return
  fi
  # 2. 用户主目录下的 .openclaw
  local home="${HOME:-$USERPROFILE}"
  if [[ -n "$home" && -d "$home/.openclaw" ]]; then
    echo "$(cd "$home/.openclaw" && pwd)"
    return
  fi
  # 3. 当前目录或脚本父目录有 openclaw.json
  if [[ -f "$SCRIPT_DIR/../openclaw.json" ]]; then
    echo "$(cd "$SCRIPT_DIR/.." && pwd)"
    return
  fi
  if [[ -f "openclaw.json" ]]; then
    echo "$(pwd)"
    return
  fi
  # 4. 默认使用 ~/.openclaw（可不存在，安装时创建）
  if [[ -n "$home" ]]; then
    echo "$home/.openclaw"
    return
  fi
  echo ""
}

echo ""
muted "  OpenClaw 监控控制台 — 自动安装"
echo ""

TARGET="${1:-}"
if [[ -n "$TARGET" ]]; then
  TARGET_DIR="$(cd "$TARGET" 2>/dev/null && pwd)" || TARGET_DIR="$TARGET"
  if [[ ! -d "$TARGET_DIR" ]]; then
    mkdir -p "$TARGET_DIR"
    TARGET_DIR="$(cd "$TARGET_DIR" && pwd)"
  fi
else
  TARGET_DIR="$(find_openclaw_dir)"
  if [[ -z "$TARGET_DIR" ]]; then
    red "  无法自动检测 OpenClaw 目录"
    echo ""
    echo "  请指定目录: $0 /path/to/.openclaw"
    echo "  或设置环境变量: export OPENCLAW_HOME=/path/to/.openclaw"
    echo ""
    exit 1
  fi
  if [[ ! -d "$TARGET_DIR" ]]; then
    mkdir -p "$TARGET_DIR"
    TARGET_DIR="$(cd "$TARGET_DIR" && pwd)"
    yellow "  已创建目录: $TARGET_DIR"
  fi
fi

SCRIPTS_DEST="$TARGET_DIR/scripts"
mkdir -p "$SCRIPTS_DEST"

# 复制必要文件
FILES=("api-usage-console.js" "service.sh")
COPIED=0
for f in "${FILES[@]}"; do
  SRC="$SCRIPT_DIR/$f"
  if [[ -f "$SRC" ]]; then
    cp "$SRC" "$SCRIPTS_DEST/" 2>/dev/null || true
    chmod +x "$SCRIPTS_DEST/$f" 2>/dev/null || true
    ((COPIED++))
  fi
done

# 若有 start.bat、install.sh 也复制（便于 scripts-package 分发）
for f in start.bat install.sh; do
  [[ -f "$SCRIPT_DIR/$f" ]] && cp "$SCRIPT_DIR/$f" "$SCRIPTS_DEST/" 2>/dev/null || true
done

chmod +x "$SCRIPTS_DEST/service.sh" 2>/dev/null || true

echo ""
green "  安装完成"
echo ""
muted "  目录: $TARGET_DIR"
muted "  脚本: $SCRIPTS_DEST"
echo ""
echo "  启动: $SCRIPTS_DEST/service.sh start"
echo "  访问: $(cyan "http://127.0.0.1:18790")"
echo ""
