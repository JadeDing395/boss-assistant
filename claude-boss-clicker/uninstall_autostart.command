#!/usr/bin/env bash
# 卸载 claude-boss-clicker 开机自启
set -e

PLIST_PATH="$HOME/Library/LaunchAgents/com.claude-boss.clicker.plist"

if [ ! -f "$PLIST_PATH" ]; then
  echo "未发现自启配置（$PLIST_PATH 不存在），无需卸载。"
  read -n 1 -s -r -p "按任意键关闭"
  exit 0
fi

launchctl unload "$PLIST_PATH" 2>/dev/null || true
rm -f "$PLIST_PATH"

echo
echo "================================================================"
echo "  ✓ 已卸载 claude-boss-clicker 开机自启"
echo
echo "  服务也已经停止运行"
echo "  之后想再用：双击 install_autostart.command 重装"
echo "  或者临时跑一次：双击 run.command"
echo "================================================================"
echo
read -n 1 -s -r -p "按任意键关闭"
