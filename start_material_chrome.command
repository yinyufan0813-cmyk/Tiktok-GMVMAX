#!/bin/zsh
set -e

export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

PROJECT_DIR="/Users/macbookair/Desktop/本地代码仓/GMVMAX"
PROFILE_DIR="$PROJECT_DIR/chrome-profile-material"
EXTENSION_DIR="$PROJECT_DIR/chrome-extension"
CDP_URL="http://127.0.0.1:9224/json/version"
TARGETS_URL="http://127.0.0.1:9224/json/list"
URL="https://ads.tiktok.com/i18n/gmv-max/dashboard?aadvid=7529709300881686546&is_refresh_page=true&oec_seller_id=7494989238589884894&bc_id=7362608187637366800&type=product"
ENCODED_URL="https://ads.tiktok.com/i18n/gmv-max/dashboard?aadvid=7529709300881686546%26is_refresh_page=true%26oec_seller_id=7494989238589884894%26bc_id=7362608187637366800%26type=product"

cd "$PROJECT_DIR"
mkdir -p "$PROFILE_DIR" logs

if /usr/bin/curl -fsS "$CDP_URL" >/dev/null 2>&1; then
  if ! /usr/bin/curl -fsS "$TARGETS_URL" | /usr/bin/grep -q "type=product"; then
    /usr/bin/curl -fsS -X PUT "http://127.0.0.1:9224/json/new?${ENCODED_URL}" >/dev/null
  fi
  echo "GMVMAX Material: 专用素材 Chrome 已经在 9224 运行。"
  exit 0
fi

/usr/bin/open -na "Google Chrome" --args \
  --remote-debugging-port=9224 \
  --user-data-dir="$PROFILE_DIR" \
  --disable-extensions-except="$EXTENSION_DIR" \
  --load-extension="$EXTENSION_DIR" \
  --no-first-run \
  --no-default-browser-check \
  "$URL" >/tmp/gmvmax-material-chrome.log 2>&1

for _ in {1..45}; do
  if /usr/bin/curl -fsS "$CDP_URL" >/dev/null 2>&1; then
    if ! /usr/bin/curl -fsS "$TARGETS_URL" | /usr/bin/grep -q "type=product"; then
      /usr/bin/curl -fsS -X PUT "http://127.0.0.1:9224/json/new?${ENCODED_URL}" >/dev/null
    fi
    echo "GMVMAX Material: 专用素材 Chrome 已启动，端口 9224。"
    exit 0
  fi
  sleep 1
done

echo "GMVMAX Material: 专用素材 Chrome 未能启动，请检查 Chrome。" >&2
exit 1
