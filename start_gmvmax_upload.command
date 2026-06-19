#!/bin/zsh
set -e

export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

PROJECT_DIR="/Users/macbookair/Desktop/本地代码仓/GMVMAX"
LIVE_PROFILE_DIR="$HOME/.gmvmax-chrome"
MATERIAL_PROFILE_DIR="$PROJECT_DIR/chrome-profile-material"
EXTENSION_DIR="$PROJECT_DIR/chrome-extension"
LIVE_CDP_URL="http://127.0.0.1:9222/json/version"
MATERIAL_CDP_URL="http://127.0.0.1:9224/json/version"
LIVE_URL="https://ads.tiktok.com/i18n/gmv-max/dashboard?aadvid=7529709300881686546&is_refresh_page=true&oec_seller_id=7494989238589884894&bc_id=7362608187637366800&activated_tab_id=2&type=live&live_campaign_page=1&live_campaign_page_size=10&list_start_date=1779096162299&list_end_date=1779096162299"
MATERIAL_URL="https://ads.tiktok.com/i18n/gmv-max/dashboard?aadvid=7529709300881686546&is_refresh_page=true&oec_seller_id=7494989238589884894&bc_id=7362608187637366800&type=product"

cd "$PROJECT_DIR"
mkdir -p "$LIVE_PROFILE_DIR" "$MATERIAL_PROFILE_DIR" logs

export GMVMAX_CONFIG="$PROJECT_DIR/config.json"
export GMVMAX_STORAGE_MODE="appsScript"
export GMVMAX_LOCAL_PERSISTENCE="0"
export GMVMAX_REMOTE_STRICT="1"

if ! /usr/bin/curl -fsS --max-time 3 "$LIVE_CDP_URL" >/dev/null 2>&1; then
  /usr/bin/open -na "Google Chrome" --args \
    --remote-debugging-port=9222 \
    --user-data-dir="$LIVE_PROFILE_DIR" \
    --no-first-run \
    --no-default-browser-check \
    "$LIVE_URL" >/tmp/gmvmax-live-chrome.log 2>&1
fi

if ! /usr/bin/curl -fsS --max-time 3 "$MATERIAL_CDP_URL" >/dev/null 2>&1; then
  /usr/bin/open -na "Google Chrome" --args \
    --remote-debugging-port=9224 \
    --user-data-dir="$MATERIAL_PROFILE_DIR" \
    --disable-extensions-except="$EXTENSION_DIR" \
    --load-extension="$EXTENSION_DIR" \
    --no-first-run \
    --no-default-browser-check \
    "$MATERIAL_URL" >/tmp/gmvmax-material-chrome.log 2>&1
fi

for _ in {1..45}; do
  /usr/bin/curl -fsS --max-time 2 "$LIVE_CDP_URL" >/dev/null 2>&1 && break
  sleep 1
done

for _ in {1..45}; do
  /usr/bin/curl -fsS --max-time 2 "$MATERIAL_CDP_URL" >/dev/null 2>&1 && break
  sleep 1
done

pkill -f "node src/network-collector.js" 2>/dev/null || true
pkill -f "node src/monitor.js" 2>/dev/null || true
pkill -f "node src/material-monitor.js" 2>/dev/null || true

nohup npm run collector > logs/collector.out.log 2> logs/collector.err.log &
nohup npm start > logs/monitor.out.log 2> logs/monitor.err.log &
nohup npm run material > logs/material-monitor.out.log 2> logs/material-monitor.err.log &

sleep 5
echo "GMVMAX upload monitor started."
echo "Collector: http://127.0.0.1:8799/health"
echo "LIVE Chrome CDP: $LIVE_CDP_URL"
echo "Material Chrome CDP: $MATERIAL_CDP_URL"
echo "Logs:"
echo "  $PROJECT_DIR/logs/collector.out.log"
echo "  $PROJECT_DIR/logs/monitor.out.log"
echo "  $PROJECT_DIR/logs/material-monitor.out.log"
