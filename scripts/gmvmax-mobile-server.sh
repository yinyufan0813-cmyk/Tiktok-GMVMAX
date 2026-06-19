#!/bin/zsh
set -e

export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

PROJECT_DIR="/Users/macbookair/GMVMAX-auto"
ENV_FILE="$PROJECT_DIR/.env.gmvmax"

if [ -f "$ENV_FILE" ]; then
  source "$ENV_FILE"
fi

cd "$PROJECT_DIR"
exec /usr/local/bin/node src/mobile-server.js
