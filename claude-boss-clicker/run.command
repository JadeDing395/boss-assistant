#!/usr/bin/env bash
# 双击运行 claude-boss 本机点击器
set -e
cd "$(dirname "$0")"

PY=${PYTHON:-python3}

if ! command -v "$PY" >/dev/null 2>&1; then
  echo "找不到 python3，请先安装 Python 3.10+"
  read -n 1 -s -r -p "按任意键关闭"
  exit 1
fi

# 第一次运行自动装依赖
if ! "$PY" -c "import flask, Quartz" 2>/dev/null; then
  echo "[首次运行] 安装依赖..."
  "$PY" -m pip install --break-system-packages -r requirements.txt
fi

echo
echo "================================================================"
echo "  claude-boss-clicker 本机点击器"
echo "  默认监听 http://127.0.0.1:12345"
echo "  关闭：在这个窗口按 Ctrl+C，或直接关掉终端"
echo "================================================================"
echo
exec "$PY" clicker_server.py
