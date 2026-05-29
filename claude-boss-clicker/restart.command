#!/usr/bin/env bash
# 重启 claude-boss-clicker（改了 clicker_server.py 之后用）
set -e

PLIST_PATH="$HOME/Library/LaunchAgents/com.claude-boss.clicker.plist"

if [ ! -f "$PLIST_PATH" ]; then
  echo "❌ 服务未安装为开机自启。"
  echo "   先双击 install_autostart.command"
  read -n 1 -s -r -p "按任意键关闭"
  exit 1
fi

launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load "$PLIST_PATH"

sleep 1.2
if curl -s http://127.0.0.1:12345/health >/dev/null 2>&1; then
  echo "✓ 服务已重启 — http://127.0.0.1:12345 在线"
else
  echo "⚠ 重启完了但 /health 没响应；看 /tmp/claude-boss-clicker.err"
fi

read -n 1 -s -r -p "按任意键关闭"
