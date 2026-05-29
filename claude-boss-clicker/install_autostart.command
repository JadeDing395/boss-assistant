#!/usr/bin/env bash
# 一次性配置 claude-boss-clicker 开机自启（macOS LaunchAgent）
# 跑完之后：
#   - 服务在后台立即启动 (http://127.0.0.1:12345)
#   - 每次电脑开机会自动启动，不需要再双击 run.command
#   - 卸载请双击 uninstall_autostart.command

set -e
cd "$(dirname "$0")"
SCRIPT_DIR=$(pwd)

PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/com.claude-boss.clicker.plist"
LOG_PATH="/tmp/claude-boss-clicker.log"
ERR_PATH="/tmp/claude-boss-clicker.err"

# 1. 找 python3
PY=$(command -v python3 || true)
if [ -z "$PY" ]; then
  echo "❌ 找不到 python3，请先安装 Python 3.10+："
  echo "   brew install python@3.12"
  read -n 1 -s -r -p "按任意键关闭"
  exit 1
fi
echo "[1/4] Python: $PY"

# 2. 装依赖（一次性）
if ! "$PY" -c "import flask, Quartz" 2>/dev/null; then
  echo "[2/4] 安装依赖..."
  "$PY" -m pip install --break-system-packages -r requirements.txt
else
  echo "[2/4] 依赖已就绪"
fi

# 3. 写 LaunchAgent plist
mkdir -p "$PLIST_DIR"
cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.claude-boss.clicker</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PY</string>
    <string>$SCRIPT_DIR/clicker_server.py</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$SCRIPT_DIR</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG_PATH</string>
  <key>StandardErrorPath</key>
  <string>$ERR_PATH</string>
</dict>
</plist>
EOF
echo "[3/4] 已写 LaunchAgent: $PLIST_PATH"

# 4. 加载（先卸载再加载，幂等）
launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load "$PLIST_PATH"
echo "[4/4] 服务已启动"

# 验证
sleep 1.5
if curl -s http://127.0.0.1:12345/health >/dev/null 2>&1; then
  STATUS="✓ 运行中"
else
  STATUS="⚠ 未响应（可能首次需要授权辅助功能；看 $ERR_PATH）"
fi

echo
echo "================================================================"
echo "  ✓ 安装完成 — claude-boss-clicker 已设为开机自启"
echo
echo "  当前状态：$STATUS"
echo "  服务地址：http://127.0.0.1:12345"
echo "  日志文件：$LOG_PATH"
echo "  错误日志：$ERR_PATH"
echo
echo "  之后再也不用双击 run.command 了"
echo "  改了 clicker_server.py 想重启？双击 restart.command"
echo "  想卸载？双击 uninstall_autostart.command"
echo
echo "  ⚠ 重要：第一次跑可能需要去 系统设置 → 隐私与安全性 → 辅助功能"
echo "      授权 Python 可执行权限，否则鼠标点击不生效"
echo "================================================================"
echo
read -n 1 -s -r -p "按任意键关闭"
