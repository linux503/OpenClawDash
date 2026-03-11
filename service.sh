#!/usr/bin/env bash
# OpenClaw API 监控控制台 — 服务管理脚本
# 用法: ./service.sh {start|stop|restart|status|logs}

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONSOLE_JS="$SCRIPT_DIR/api-usage-console.js"
PID_FILE="$SCRIPT_DIR/.api-console.pid"
LOG_FILE="$SCRIPT_DIR/.api-console.log"
PORT=18790

red() { echo -e "\033[31m$*\033[0m"; }
green() { echo -e "\033[32m$*\033[0m"; }
yellow() { echo -e "\033[33m$*\033[0m"; }
muted() { echo -e "\033[90m$*\033[0m"; }
cyan() { echo -e "\033[36m$*\033[0m"; }
bold() { echo -e "\033[1m$*\033[0m"; }

get_pid() {
  [[ -f "$PID_FILE" ]] && cat "$PID_FILE" 2>/dev/null || echo ""
}

is_running() {
  local pid=$(get_pid)
  [[ -z "$pid" ]] && return 1
  kill -0 "$pid" 2>/dev/null
}

show_status() {
  echo ""
  echo "  $(muted '╭─') $(bold '🦞 OpenClaw API 监控控制台')"
  echo "  $(muted '│')"
  echo "  $(muted '│')  $(muted '─── 服务状态 ───')"
  echo "  $(muted '│')"
  if is_running; then
    local pid=$(get_pid)
    echo "  $(muted '│')  $(muted '状态')  $(green '● 运行中')"
    echo "  $(muted '│')  $(muted 'PID')    $pid"
    echo "  $(muted '│')  $(muted '端口')  $PORT"
    echo "  $(muted '│')  $(muted '地址')  $(cyan "http://127.0.0.1:$PORT")"
    if command -v ps >/dev/null 2>&1; then
      local rss=$(ps -p "$pid" -o rss= 2>/dev/null | tr -d ' ')
      local cpu=$(ps -p "$pid" -o %cpu= 2>/dev/null | tr -d ' ')
      if [[ -n "$rss" ]]; then
        local mb=$(( rss / 1024 ))
        [[ "$rss" -gt 10485760 ]] 2>/dev/null && mb=$(( rss / 1024 / 1024 ))
        echo "  $(muted '│')  $(muted '内存')  ${mb} MB"
      fi
      if [[ -n "$cpu" ]]; then
        echo "  $(muted '│')  $(muted 'CPU')   ${cpu}%"
      fi
    fi
  else
    echo "  $(muted '│')  $(muted '状态')  $(red '● 未运行')"
  fi
  echo "  $(muted '╰─')"
  echo ""
}

port_in_use() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -i ":$PORT" -sTCP:LISTEN -t 2>/dev/null | grep -q .
  else
    return 1
  fi
}

cmd_start() {
  if is_running; then
    yellow "  控制台已在运行 (PID: $(get_pid))"
    show_status
    return 0
  fi
  if port_in_use; then
    red "  错误: 端口 $PORT 已被占用"
    muted "  可执行 lsof -i :$PORT 查看占用进程，或先执行 $0 stop"
    return 1
  fi
  if [[ ! -f "$CONSOLE_JS" ]]; then
    red "  错误: 找不到 $CONSOLE_JS"
    return 1
  fi
  if ! command -v node >/dev/null 2>&1; then
    red "  错误: 未找到 node 命令"
    return 1
  fi
  echo "  正在启动..."
  OPENCLAW_STATE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)" nohup node "$CONSOLE_JS" >> "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  sleep 1
  if is_running; then
    green "  已启动"
    show_status
  else
    red "  启动失败，请查看日志: $LOG_FILE"
    rm -f "$PID_FILE"
    return 1
  fi
}

cmd_stop() {
  if is_running; then
    :
  elif port_in_use && command -v lsof >/dev/null 2>&1; then
    yellow "  未找到 PID 文件，但端口 $PORT 被占用，尝试终止占用进程..."
    local pids=$(lsof -i ":$PORT" -sTCP:LISTEN -t 2>/dev/null)
    if [[ -n "$pids" ]]; then
      echo "$pids" | xargs kill 2>/dev/null || true
      sleep 2
      echo "$pids" | xargs kill -9 2>/dev/null || true
      green "  已停止"
    fi
    rm -f "$PID_FILE"
    return 0
  else
    yellow "  控制台未在运行"
    rm -f "$PID_FILE"
    return 0
  fi
  local pid=$(get_pid)
  echo "  正在停止 (PID: $pid)..."
  kill "$pid" 2>/dev/null || true
  for i in {1..5}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      green "  已停止"
      rm -f "$PID_FILE"
      return 0
    fi
    sleep 1
  done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  green "  已强制停止"
}

cmd_restart() {
  cmd_stop
  sleep 1
  cmd_start
}

cmd_logs() {
  if [[ -f "$LOG_FILE" ]]; then
    tail -f "$LOG_FILE"
  else
    yellow "  暂无日志文件"
  fi
}

case "${1:-status}" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_restart ;;
  status)  show_status ;;
  logs)    cmd_logs ;;
  *)
    echo "用法: $0 {start|stop|restart|status|logs}"
    echo ""
    echo "  start   — 启动监控控制台"
    echo "  stop    — 停止监控控制台"
    echo "  restart — 重启监控控制台"
    echo "  status  — 查看运行状态与资源占用"
    echo "  logs    — 实时查看日志"
    exit 1
    ;;
esac
