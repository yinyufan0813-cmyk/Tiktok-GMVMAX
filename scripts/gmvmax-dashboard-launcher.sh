#!/bin/zsh
set -e

PROJECT_DIR="/Users/macbookair/GMVMAX-auto"
PORT=8787

cd "$PROJECT_DIR"
mkdir -p logs

# Prime one fresh collection when the panel starts. The recurring LaunchAgent
# keeps this updated every 10 minutes after login.
/bin/zsh scripts/gmvmax-auto-runner.sh >/tmp/gmvmax-dashboard-monitor.log 2>&1 &

for _ in {1..20}; do
  if /usr/bin/python3 - <<'PY'
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
    break
  fi
  sleep 1
done

sleep 1
/usr/bin/osascript <<APPLESCRIPT
set targetBase to "http://127.0.0.1:$PORT/dashboard.html"
set targetUrl to targetBase & "?v=" & (do shell script "date +%s")
tell application "Google Chrome"
  activate
  set matched to false
  repeat with chromeWindow in windows
    set tabIndex to 1
    repeat with chromeTab in tabs of chromeWindow
      if (URL of chromeTab) starts with targetBase then
        set URL of chromeTab to targetUrl
        set active tab index of chromeWindow to tabIndex
        set index of chromeWindow to 1
        set bounds of chromeWindow to {60, 80, 1280, 500}
        set matched to true
        exit repeat
      end if
      set tabIndex to tabIndex + 1
    end repeat
    if matched then exit repeat
  end repeat
  if matched is false then
    set dashboardWindow to make new window
    set URL of active tab of dashboardWindow to targetUrl
    set bounds of dashboardWindow to {60, 80, 1280, 500}
  end if
end tell
APPLESCRIPT
