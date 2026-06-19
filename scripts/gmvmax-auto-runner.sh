#!/bin/zsh
set -e

export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

PROJECT_DIR="/Users/macbookair/GMVMAX-auto"
PROFILE_DIR="$HOME/.gmvmax-chrome"
LOG_DIR="${GMVMAX_DATA_DIR:-/Users/macbookair/GMVMAX-auto/logs}"
LOCK_DIR="/tmp/gmvmax-auto-runner.lock"
ENV_FILE="$PROJECT_DIR/.env.gmvmax"
CDP_URL="http://127.0.0.1:9222/json/version"
URL="https://ads.tiktok.com/i18n/gmv-max/dashboard?aadvid=7529709300881686546&is_refresh_page=true&oec_seller_id=7494989238589884894&bc_id=7362608187637366800&activated_tab_id=2&type=live&live_campaign_page=1&live_campaign_page_size=10&list_start_date=1779096162299&list_end_date=1779096162299"

cd "$PROJECT_DIR"
if [ -f "$ENV_FILE" ]; then
  source "$ENV_FILE"
fi
LOG_DIR="${GMVMAX_DATA_DIR:-$LOG_DIR}"
mkdir -p "$PROFILE_DIR" "$LOG_DIR"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  EXISTING_PID="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [ -n "$EXISTING_PID" ] && kill -0 "$EXISTING_PID" 2>/dev/null; then
    echo "GMVMAX: 自动采集仍在运行中，跳过本轮以避免重复刷新。PID: $EXISTING_PID"
    exit 0
  fi
  rm -rf "$LOCK_DIR"
  mkdir "$LOCK_DIR"
fi

echo "$$" > "$LOCK_DIR/pid"
trap 'rm -rf "$LOCK_DIR"' EXIT INT TERM

if ! /usr/bin/curl -fsS "$CDP_URL" >/dev/null 2>&1; then
  /usr/bin/open -na "Google Chrome" --args \
    --remote-debugging-port=9222 \
    --user-data-dir="$PROFILE_DIR" \
    --no-first-run \
    --no-default-browser-check \
    "$URL" >/tmp/gmvmax-chrome.log 2>&1

  for _ in {1..45}; do
    if /usr/bin/curl -fsS "$CDP_URL" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
fi

if ! /usr/bin/curl -fsS "$CDP_URL" >/dev/null 2>&1; then
  echo "GMVMAX: 专用 Chrome 未能启动，请手动打开悬浮窗或检查 Chrome。" >&2
  exit 1
fi

GMVMAX_OUTPUT_DIR="$LOG_DIR" /usr/local/bin/npm run once
