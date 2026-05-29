"""
claude-boss-clicker — 本机 OS 级真鼠标点击器
配套 claude-boss插件 使用：扩展把"点哪里"通过 HTTP 发给本程序，
本程序用 macOS Quartz CGEvent 真实模拟鼠标移动 + 点击，
事件从 OS HID 输入栈进入 Chrome，对页面 JS 来说 isTrusted === true。

设计取舍：
- 只接受 127.0.0.1 的请求；不开公网端口
- 每次点击前弹一个 3 秒倒计时确认窗，可 Esc 取消（你说的"跳出来点之前弹个提示"）
- 用 tkinter 做确认窗（Python 自带，零依赖）
- 用 PyObjC 调 Quartz 做点击（pip install pyobjc-framework-Quartz）
- HTTP 用 Flask（pip install flask）

启动：
  python3 clicker_server.py
默认监听 127.0.0.1:12345
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import threading
import time
import tkinter as tk
from tkinter import ttk
from typing import Optional

try:
    from flask import Flask, jsonify, request
except ImportError:
    print("缺少 flask：pip install flask", file=sys.stderr)
    sys.exit(2)

try:
    import Quartz
    from AppKit import NSScreen
except ImportError:
    print("缺少 pyobjc：pip install pyobjc-framework-Quartz pyobjc-framework-Cocoa", file=sys.stderr)
    sys.exit(2)


# ---------- 日志 ----------
LOG_FORMAT = "[%(asctime)s] %(levelname)s %(message)s"
logging.basicConfig(level=logging.INFO, format=LOG_FORMAT, datefmt="%H:%M:%S")
log = logging.getLogger("clicker")


# ---------- 鼠标事件（CGEvent，OS HID 级别） ----------
def _make_event(event_type: int, x: float, y: float, button: int = Quartz.kCGMouseButtonLeft):
    """构造一个 CGEvent，坐标为屏幕全局逻辑像素（CSS 像素，已含 DPI）。"""
    return Quartz.CGEventCreateMouseEvent(None, event_type, (x, y), button)


def _post_event(evt) -> None:
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, evt)


def move_mouse_smoothly(target_x: float, target_y: float, duration_ms: int = 240, steps: int = 18) -> None:
    """
    模拟人手移动：从当前位置到目标位置，分若干段平滑过渡 + 微抖动。
    duration_ms 总时长，steps 段数。
    """
    cur = Quartz.CGEventGetLocation(Quartz.CGEventCreate(None))
    sx, sy = float(cur.x), float(cur.y)
    dx = (target_x - sx) / steps
    dy = (target_y - sy) / steps
    step_sleep = max(0.005, duration_ms / 1000.0 / steps)
    import random
    for i in range(1, steps + 1):
        # 中段微抖动 ±2px，模拟手部细微抖动
        jitter_x = random.uniform(-1.5, 1.5) if 2 <= i <= steps - 2 else 0
        jitter_y = random.uniform(-1.5, 1.5) if 2 <= i <= steps - 2 else 0
        nx = sx + dx * i + jitter_x
        ny = sy + dy * i + jitter_y
        _post_event(_make_event(Quartz.kCGEventMouseMoved, nx, ny))
        time.sleep(step_sleep)
    # 最后一帧落到精确坐标
    _post_event(_make_event(Quartz.kCGEventMouseMoved, target_x, target_y))


def click_at(x: float, y: float, dwell_ms: int = 90) -> None:
    """
    在 (x, y) 处真鼠标点击。完整 click 必须满足：
    1. 鼠标实际位置（OS 视角）必须在 (x, y)：用 CGWarpMouseCursorPosition 强制同步
    2. CGEvent 必须设 kCGMouseEventClickState = 1，否则 Chrome 不认是 click
    3. mouseDown 前先 fire 一次 mouseMoved 让按钮进 hover 状态（很多按钮 click handler 需要）
    4. mouseDown ↔ mouseUp 之间留足够 dwell 时间（>=80ms 真人级）
    """
    # 1. 强制同步 OS 鼠标位置 + 解锁鼠标-光标关联（确保下一次 event 在新位置）
    try:
        Quartz.CGWarpMouseCursorPosition((x, y))
        Quartz.CGAssociateMouseAndMouseCursorPosition(True)
    except Exception:
        pass
    time.sleep(0.04)
    # 2. fire mouseMoved 让 hover 状态生效
    _post_event(_make_event(Quartz.kCGEventMouseMoved, x, y))
    time.sleep(0.10)
    # 3. mouseDown
    down = _make_event(Quartz.kCGEventLeftMouseDown, x, y)
    Quartz.CGEventSetIntegerValueField(down, Quartz.kCGMouseEventClickState, 1)
    _post_event(down)
    time.sleep(dwell_ms / 1000.0)
    # 4. mouseUp（坐标必须和 down 一致）
    up = _make_event(Quartz.kCGEventLeftMouseUp, x, y)
    Quartz.CGEventSetIntegerValueField(up, Quartz.kCGMouseEventClickState, 1)
    _post_event(up)


def human_click(x: float, y: float) -> None:
    """先平滑滑过去（视觉上像真人），再调 click_at 真正点。"""
    move_mouse_smoothly(x, y, duration_ms=280 + int(80 * (hash((x, y)) % 5) / 4), steps=20)
    # 平滑移动结束后留一个明显的 settle 窗口
    time.sleep(0.18)
    click_at(x, y, dwell_ms=90)


# ---------- 屏幕几何辅助 ----------
def screen_height() -> int:
    """主屏高度（逻辑像素）。某些场景需要把 web 的 top→bottom 坐标系翻成屏幕系。"""
    try:
        f = NSScreen.mainScreen().frame()
        return int(f.size.height)
    except Exception:
        return 1080


# ---------- 用户空闲检测 ----------
def seconds_since_user_input() -> float:
    """
    返回用户最近一次硬件输入（鼠标移动 / 点击 / 键盘）距今的秒数。
    脚本自己 CGEventPost 触发的事件不会计入"硬件"输入，
    所以这个数值能真实反映"真人有没有在动电脑"。
    """
    try:
        return float(Quartz.CGEventSourceSecondsSinceLastEventType(
            Quartz.kCGEventSourceStateHIDSystemState,
            Quartz.kCGAnyInputEventType,
        ))
    except Exception:
        # API 不可用时返回一个大数（视为已空闲），避免锁死整批
        return 999999.0


def wait_until_idle(min_idle_sec: float, max_wait_sec: float, poll_interval: float = 1.0) -> bool:
    """
    等待用户连续空闲 >= min_idle_sec 秒。
    最多等 max_wait_sec 秒；超时返回 False（调用方决定怎么处理）。
    返回 True = 已空闲达标可以点击；False = 等到超时仍在动。
    """
    if min_idle_sec <= 0:
        return True
    start = time.time()
    last_log_at = 0.0
    while True:
        idle = seconds_since_user_input()
        if idle >= min_idle_sec:
            return True
        elapsed = time.time() - start
        if elapsed >= max_wait_sec:
            return False
        # 每 5 秒打一次日志，让人知道在等
        if elapsed - last_log_at >= 5:
            log.info("等候空闲：当前已空闲 %.1fs（需 %.0fs），已等 %.0fs / 最多 %.0fs",
                     idle, min_idle_sec, elapsed, max_wait_sec)
            last_log_at = elapsed
        time.sleep(poll_interval)


def is_within_main_screen(x: float, y: float) -> bool:
    """简单边界检查；如果坐标明显越界，拒绝执行。"""
    try:
        for s in NSScreen.screens():
            f = s.frame()
            if (f.origin.x <= x <= f.origin.x + f.size.width and
                    f.origin.y <= y <= f.origin.y + f.size.height):
                return True
    except Exception:
        return True  # NSScreen 不可用时不拦
    return False


# ---------- Tk 确认弹窗 ----------
class ConfirmResult:
    APPROVED = "approved"
    CANCELLED = "cancelled"
    TIMEOUT = "timeout"


_POPUP_LOCK = threading.Lock()


def show_confirm_popup(title: str, message: str, countdown: int = 3) -> str:
    """
    用 macOS 原生 osascript 弹确认对话框 —— 比 tkinter 可靠，
    系统级超时 `giving up after N` 不会卡住事件循环。

    - 倒计时到点 / 默认按钮 → APPROVED
    - 用户按"取消" → CANCELLED
    - osascript 异常 → TIMEOUT（默认放行，避免卡死整批）
    """
    import subprocess
    with _POPUP_LOCK:
        # AppleScript 字符串里的双引号 / 反斜杠要转义
        def _escape(s: str) -> str:
            return s.replace("\\", "\\\\").replace('"', '\\"')

        script = (
            f'display dialog "{_escape(message)}" '
            f'with title "{_escape(title)}" '
            f'buttons {{"取消", "立即点"}} '
            f'default button "立即点" '
            f'cancel button "取消" '
            f'giving up after {int(countdown)}'
        )
        try:
            r = subprocess.run(
                ["osascript", "-e", script],
                capture_output=True, text=True,
                timeout=int(countdown) + 6,  # 给 osascript 一些缓冲时间
            )
            out = (r.stdout or "").strip()
            err = (r.stderr or "").strip()
            # osascript 用户点取消时 returncode = 1，输出形如 "User canceled. (-128)"
            if r.returncode != 0:
                if "-128" in err or "canceled" in err.lower() or "取消" in err:
                    return ConfirmResult.CANCELLED
                # 其它错误：保守起见判为取消（不放行点击），并记日志
                log.warning("osascript 异常 returncode=%d, err=%s", r.returncode, err[:200])
                return ConfirmResult.CANCELLED
            # 正常返回：判断是 default-button-press 还是 timeout
            # giving up 时输出包含 "gave up:true"；点了按钮则包含 "button returned:..."
            if "gave up:true" in out:
                return ConfirmResult.TIMEOUT  # 等同于 APPROVED（按 default button）
            return ConfirmResult.APPROVED
        except subprocess.TimeoutExpired:
            log.warning("osascript 整体超时（极少见），按取消处理")
            return ConfirmResult.CANCELLED
        except FileNotFoundError:
            log.error("找不到 osascript（macOS 自带）")
            return ConfirmResult.CANCELLED
        except Exception as e:
            log.exception("show_confirm_popup 异常: %s", e)
            return ConfirmResult.CANCELLED


# ---------- HTTP server ----------
app = Flask(__name__)


# 允许 Chrome 扩展从 Boss 页面跨源 fetch 本机端口
# 仅本机服务，且只允许常见的 GET/POST + 必要头，安全
@app.after_request
def add_cors_headers(resp):
    origin = request.headers.get("Origin", "")
    # 允许任意来源（本机服务，且只接受 127.0.0.1 上的请求）
    resp.headers["Access-Control-Allow-Origin"] = origin or "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    resp.headers["Access-Control-Max-Age"] = "600"
    return resp


@app.route("/click", methods=["OPTIONS"])
@app.route("/health", methods=["OPTIONS"])
def cors_preflight():
    # 让浏览器的 OPTIONS 预检直接通过
    return ("", 204)


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"ok": True, "version": "1.0.0", "screen_h": screen_height()})


@app.route("/click", methods=["POST"])
def click_endpoint():
    """
    body: {
      "x": 1080.5, "y": 640.2,
      "candidateName": "张**",
      "candidateId": "domGeekId:abc",
      "draftMessage": "你好 ...",
      "skipConfirm": false  # 默认 false，每次都弹确认
    }
    """
    try:
        payload = request.get_json(force=True, silent=True) or {}
    except Exception:
        return jsonify({"ok": False, "error": "invalid json"}), 400

    x = payload.get("x")
    y = payload.get("y")
    if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
        return jsonify({"ok": False, "error": "x/y must be numbers"}), 400

    name = str(payload.get("candidateName", "(未知)"))
    cid = str(payload.get("candidateId", ""))
    draft = str(payload.get("draftMessage", ""))
    skip_confirm = bool(payload.get("skipConfirm", False))
    idle_min_sec = float(payload.get("idleMinSec", 0) or 0)
    idle_max_wait_sec = float(payload.get("idleMaxWaitSec", 300) or 300)

    if not is_within_main_screen(x, y):
        log.warning("拒绝点击：坐标 (%.1f, %.1f) 不在任何屏幕范围内", x, y)
        return jsonify({"ok": False, "error": "coordinate out of screen"}), 400

    log.info("收到点击请求 → 候选人=%s id=%s 坐标=(%.1f, %.1f)", name, cid, x, y)

    # idle gate：仅在用户空闲达到阈值时才点（避免打扰你正在做事）
    if idle_min_sec > 0:
        log.info("等候用户空闲 ≥ %.0fs（最多等 %.0fs）...", idle_min_sec, idle_max_wait_sec)
        ok = wait_until_idle(idle_min_sec, idle_max_wait_sec)
        if not ok:
            log.info("等候超时：你一直在用电脑，跳过 %s", name)
            return jsonify({"ok": False, "idleTimeout": True, "error": "user busy"}), 200

    # 弹确认窗
    if not skip_confirm:
        msg_short = draft[:60] + ("…" if len(draft) > 60 else "")
        title = "claude-boss 即将打招呼"
        body = f"候选人：{name}\n草稿：{msg_short or '（无）'}\n坐标：({x:.0f}, {y:.0f})"
        decision = show_confirm_popup(title, body, countdown=3)
        if decision == ConfirmResult.CANCELLED:
            log.info("用户取消：%s", name)
            return jsonify({"ok": False, "cancelled": True}), 200
        # APPROVED（用户主动点了"立即点"）或 TIMEOUT（3 秒到了走默认按钮）→ 都放行

    # 真鼠标点击
    try:
        human_click(x, y)
        log.info("点击完成：%s @ (%.1f, %.1f)", name, x, y)
        return jsonify({"ok": True})
    except Exception as e:
        log.exception("点击失败")
        return jsonify({"ok": False, "error": str(e)}), 500


@app.errorhandler(404)
def not_found(_e):
    return jsonify({"ok": False, "error": "not found"}), 404


def main():
    parser = argparse.ArgumentParser(description="claude-boss 本机点击器")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址（默认仅本机）")
    parser.add_argument("--port", type=int, default=12345)
    args = parser.parse_args()

    if args.host not in ("127.0.0.1", "localhost", "::1"):
        log.warning("注意：监听了非本机地址 %s — 不要在不可信网络下使用", args.host)

    log.info("claude-boss-clicker 启动 → http://%s:%d", args.host, args.port)
    log.info("健康检查：curl http://%s:%d/health", args.host, args.port)
    log.info("提示：首次运行需要在 系统设置 → 隐私与安全 → 辅助功能 里授权 Python 可执行权限")
    # 关掉 flask 的请求日志降噪
    werkzeug_log = logging.getLogger("werkzeug")
    werkzeug_log.setLevel(logging.WARNING)
    app.run(host=args.host, port=args.port, debug=False, threaded=False)


if __name__ == "__main__":
    main()
