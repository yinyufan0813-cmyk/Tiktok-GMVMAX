#!/bin/zsh
set -e

export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

PROJECT_DIR="/Users/macbookair/Desktop/本地代码仓/GMVMAX"
PROFILE_DIR="$HOME/.gmvmax-chrome-explore"
CDP_URL="http://127.0.0.1:9223/json/version"
TARGETS_URL="http://127.0.0.1:9223/json/list"
URL="https://ads.tiktok.com/i18n/gmv-max/dashboard?aadvid=7529709300881686546&is_refresh_page=true&oec_seller_id=7494989238589884894&bc_id=7362608187637366800&activated_tab_id=2&type=live&live_campaign_page=1&live_campaign_page_size=10&list_start_date=1779096162299&list_end_date=1779096162299"
ENCODED_URL="https://ads.tiktok.com/i18n/gmv-max/dashboard?aadvid=7529709300881686546%26is_refresh_page=true%26oec_seller_id=7494989238589884894%26bc_id=7362608187637366800%26activated_tab_id=2%26type=live%26live_campaign_page=1%26live_campaign_page_size=10%26list_start_date=1779096162299%26list_end_date=1779096162299"

cd "$PROJECT_DIR"
mkdir -p "$PROFILE_DIR" logs-explore

if /usr/bin/curl -fsS "$CDP_URL" >/dev/null 2>&1; then
  if ! /usr/bin/curl -fsS "$TARGETS_URL" | /usr/bin/grep -q "gmv-max/dashboard"; then
    /usr/bin/curl -fsS -X PUT "http://127.0.0.1:9223/json/new?${ENCODED_URL}" >/dev/null
  fi
  echo "GMVMAX Explore: 专用探索 Chrome 已经在 9223 运行。"
  exit 0
fi

/usr/bin/open -na "Google Chrome" --args \
  --remote-debugging-port=9223 \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run \
  --no-default-browser-check \
  "$URL" >/tmp/gmvmax-explore-chrome.log 2>&1

for _ in {1..45}; do
  if /usr/bin/curl -fsS "$CDP_URL" >/dev/null 2>&1; then
    if ! /usr/bin/curl -fsS "$TARGETS_URL" | /usr/bin/grep -q "gmv-max/dashboard"; then
      /usr/bin/curl -fsS -X PUT "http://127.0.0.1:9223/json/new?${ENCODED_URL}" >/dev/null
    fi
    echo "GMVMAX Explore: 专用探索 Chrome 已启动，端口 9223。"
    exit 0
  fi
  sleep 1
done

echo "GMVMAX Explore: 专用探索 Chrome 未能启动，请检查 Chrome。" >&2
exit 1
