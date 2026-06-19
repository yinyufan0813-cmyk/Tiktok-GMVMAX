#!/bin/zsh
set -e

export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

PROJECT_DIR="/Users/macbookair/Desktop/本地代码仓/GMVMAX"
LOCK_DIR="/tmp/gmvmax-explore-runner.lock"
CDP_URL="http://127.0.0.1:9223/json/version"

cd "$PROJECT_DIR"
mkdir -p logs-explore

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  EXISTING_PID="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [ -n "$EXISTING_PID" ] && kill -0 "$EXISTING_PID" 2>/dev/null; then
    echo "GMVMAX Explore: 探索采集仍在运行中，跳过本轮。PID: $EXISTING_PID"
    exit 0
  fi
  rm -rf "$LOCK_DIR"
  mkdir "$LOCK_DIR"
fi

echo "$$" > "$LOCK_DIR/pid"
trap 'rm -rf "$LOCK_DIR"' EXIT INT TERM

if ! /usr/bin/curl -fsS "$CDP_URL" >/dev/null 2>&1; then
  /bin/zsh "$PROJECT_DIR/start_explore_chrome.command"
fi

GMVMAX_CONFIG="$PROJECT_DIR/config.explore.json" \
GMVMAX_OUTPUT_DIR="$PROJECT_DIR/logs-explore" \
/usr/local/bin/npm run once
