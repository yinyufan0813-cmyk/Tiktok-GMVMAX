#!/bin/zsh
set -e

PROJECT_DIR="/Users/macbookair/Desktop/本地代码仓/GMVMAX"
PROFILE_DIR="$HOME/.gmvmax-chrome"
CDP_URL="http://127.0.0.1:9222/json/version"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
URL="https://ads.tiktok.com/i18n/gmv-max/dashboard?aadvid=7529709300881686546&is_refresh_page=true&oec_seller_id=7494989238589884894&bc_id=7362608187637366800&activated_tab_id=2&type=live&live_campaign_page=1&live_campaign_page_size=10&list_start_date=1779096162299&list_end_date=1779096162299"

cd "$PROJECT_DIR"
mkdir -p "$PROFILE_DIR" logs

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
  echo "GMVMAX: 专用 Chrome 未能启动，请手动运行 start_dashboard.command 后再试。" >&2
  exit 1
fi

/usr/local/bin/npm run once
