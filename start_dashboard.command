#!/bin/zsh
SCRIPT_DIR="${0:A:h}"
cd "$SCRIPT_DIR" || exit 1
PORT=8787
LOCK=/tmp/gmvmax-dashboard-window.lock

# 打开悬浮窗时，同步确保专用 Chrome 已启动，并立即采集一次数据。
if [ -x "$SCRIPT_DIR/scripts/gmvmax-monitor.sh" ]; then
  "$SCRIPT_DIR/scripts/gmvmax-monitor.sh" >/tmp/gmvmax-dashboard-monitor.log 2>&1 &
fi

if ! /usr/bin/python3 - <<'PY'
import socket
sock = socket.socket()
try:
    sock.settimeout(0.25)
    sock.connect(("127.0.0.1", 8787))
except OSError:
    raise SystemExit(1)
else:
    raise SystemExit(0)
finally:
    sock.close()
PY
then
  /usr/bin/python3 -m http.server $PORT --bind 127.0.0.1 >/tmp/gmvmax-dashboard-server.log 2>&1 &
fi
sleep 1

# 旧锁文件可能会留下来，导致脚本退出但窗口没有打开。这里每次都重新拉起或激活窗口。
rm -f "$LOCK"
open -na "Google Chrome" --args --app="http://127.0.0.1:$PORT/dashboard.html" --window-size=1220,420 --window-position=60,80
/usr/bin/osascript -e 'tell application "Google Chrome" to activate' >/dev/null 2>&1
date > "$LOCK"
