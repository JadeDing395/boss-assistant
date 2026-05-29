#!/usr/bin/env bash
# claude-boss 套装一键安装脚本
# 双击我，跟着提示走。绝大部分步骤会自动完成。

set -e
cd "$(dirname "$0")"
PKG_DIR=$(pwd)
CLICKER_DIR="$PKG_DIR/claude-boss-clicker"
EXT_DIR="$PKG_DIR/claude-boss插件"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/com.claude-boss.clicker.plist"
LOG_PATH="/tmp/claude-boss-clicker.log"
ERR_PATH="/tmp/claude-boss-clicker.err"

# 颜色
GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

# 系统对话框
dlg() {
  /usr/bin/osascript -e "display dialog \"$1\" with title \"claude-boss 安装\" buttons {\"$2\"} default button \"$2\" giving up after 60" >/dev/null 2>&1 || true
}
dlg_choice() {
  /usr/bin/osascript -e "display dialog \"$1\" with title \"claude-boss 安装\" buttons {\"$2\", \"$3\"} default button \"$3\""
}

clear
cat <<'BANNER'

  ╔════════════════════════════════════════════════════════════╗
  ║                                                            ║
  ║          claude-boss 套装 — 一键安装                       ║
  ║                                                            ║
  ║   我会自动完成: 装依赖、配置后台服务、打开 Chrome 扩展页   ║
  ║   你只需要点几次确认。预计 2 分钟。                        ║
  ║                                                            ║
  ╚════════════════════════════════════════════════════════════╝

BANNER

echo
echo -e "${CYAN}[1/5] 检测 Python ...${NC}"

PY=$(command -v python3 || true)
if [ -z "$PY" ]; then
  echo -e "${RED}❌ 未检测到 Python 3${NC}"
  dlg "未检测到 Python 3。\\n\\n点确定后会自动打开 Python 官网下载页。\\n请下载 macOS installer (推荐 3.12) → 双击安装 → 装完再次双击「开始安装.command」继续。" "好"
  open "https://www.python.org/downloads/macos/"
  exit 1
fi
PY_VER=$("$PY" --version 2>&1)
echo -e "${GREEN}    ✓ $PY_VER ($PY)${NC}"

echo
echo -e "${CYAN}[2/5] 安装 Python 依赖（首次约 30 秒）...${NC}"
if "$PY" -c "import flask, Quartz" 2>/dev/null; then
  echo -e "${GREEN}    ✓ 依赖已就绪${NC}"
else
  if ! "$PY" -m pip install --break-system-packages -q -r "$CLICKER_DIR/requirements.txt"; then
    # 回退 --user
    "$PY" -m pip install --user -q -r "$CLICKER_DIR/requirements.txt"
  fi
  echo -e "${GREEN}    ✓ 依赖装好了${NC}"
fi

echo
echo -e "${CYAN}[3/5] 配置开机自启服务 ...${NC}"
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
    <string>$CLICKER_DIR/clicker_server.py</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$CLICKER_DIR</string>
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
launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load "$PLIST_PATH"
sleep 1.5
if curl -s http://127.0.0.1:12345/health >/dev/null 2>&1; then
  echo -e "${GREEN}    ✓ 后台服务运行中 — http://127.0.0.1:12345${NC}"
else
  echo -e "${YELLOW}    ⚠ 服务启动了但 /health 无响应（不影响后续，下面会处理）${NC}"
fi

echo
echo -e "${CYAN}[4/5] 准备加载 Chrome 扩展 ...${NC}"
echo
echo "        即将打开 Chrome 的「扩展程序」页面。"
echo "        在那个页面按以下步骤："
echo
echo "          ① 右上角开启「开发者模式」开关"
echo "          ② 点左上角「加载已解压的扩展程序」按钮"
echo "          ③ 在弹出框里选择这个文件夹："
echo
echo -e "             ${YELLOW}$EXT_DIR${NC}"
echo
echo "          ④ 看到「claude-boss插件（低风险版）」加进来就好"
echo
sleep 0.5

# 把扩展路径复制到剪贴板，方便用户在选择对话框里粘贴
echo -n "$EXT_DIR" | pbcopy 2>/dev/null && echo "        （扩展路径已复制到剪贴板，选择对话框里 ⌘V 粘贴最快）" || true

echo
echo -e "${YELLOW}     按回车 → 自动打开 chrome://extensions/ 页面${NC}"
read -r

# 优先 Chrome；没有 Chrome 试 Edge / Brave
if open -a "Google Chrome" "chrome://extensions/" 2>/dev/null; then
  :
elif open -a "Microsoft Edge" "edge://extensions/" 2>/dev/null; then
  echo -e "${YELLOW}    用了 Edge。同样开发者模式 → 加载已解压${NC}"
elif open -a "Brave Browser" "brave://extensions/" 2>/dev/null; then
  echo -e "${YELLOW}    用了 Brave${NC}"
else
  echo -e "${RED}    ❌ 找不到 Chrome / Edge / Brave，请手动装一个${NC}"
fi

echo
echo "        加载完扩展后，回到这里按回车继续 ..."
read -r

echo
echo -e "${CYAN}[5/5] 提醒：辅助功能权限${NC}"
echo
echo "        第一次点「打招呼」时，macOS 会弹一个权限请求："
echo
echo -e "          ${YELLOW}「Python」想要控制此电脑${NC}"
echo
echo "        必须点「允许」并去「系统设置 → 隐私与安全性 →"
echo "        辅助功能」里给 Python 打勾。否则鼠标点击不生效。"
echo
echo "        如果你想现在就开，按回车自动打开那个设置页。"
read -r
open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility" 2>/dev/null || true

echo
echo
echo "  ════════════════════════════════════════════════════════════"
echo -e "  ${GREEN}     ✓ 全部装好了！${NC}"
echo "  ════════════════════════════════════════════════════════════"
echo
echo "  接下来怎么用："
echo
echo "    1. 打开 Boss 直聘网页（任意 zhipin.com 页面）"
echo "    2. 点 Chrome 右上角 claude-boss 图标，会从右边弹出侧边栏"
echo "    3. 配置岗位 / JD / AI 后点「开始」"
echo
echo "  详细使用说明："
echo "    双击这个文件夹里的「使用说明.html」"
echo
echo "  日常维护："
echo "    • 后台服务挂了？双击 claude-boss-clicker/restart.command"
echo "    • 想卸载？双击 claude-boss-clicker/uninstall_autostart.command"
echo "    • 看后台日志：终端 tail -f $LOG_PATH"
echo
echo
read -n 1 -s -r -p "按任意键关闭此窗口"
echo
