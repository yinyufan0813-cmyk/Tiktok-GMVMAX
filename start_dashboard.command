#!/bin/zsh
SCRIPT_DIR="${0:A:h}"
cd "$SCRIPT_DIR" || exit 1
PORT=8787
LOCK=/tmp/gmvmax-dashboard-window.lock
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
if [ -f "$LOCK" ]; then
  exit 0
fi
open -na "Google Chrome" --args --app="http://127.0.0.1:$PORT/dashboard.html" --window-size=1220,420 --window-position=60,80
date > "$LOCK"
