#!/bin/zsh
SCRIPT_DIR="${0:A:h}"
cd "$SCRIPT_DIR" || exit 1
PORT=${GMVMAX_MOBILE_PORT:-8788}
node src/mobile-server.js
