#!/bin/zsh
SCRIPT_DIR="${0:A:h}"
rm -f /tmp/gmvmax-dashboard-window.lock
open "$SCRIPT_DIR/start_dashboard.command"
