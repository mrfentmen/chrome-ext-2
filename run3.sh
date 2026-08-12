#!/bin/bash
# run3.sh — whiteboard feature test (resize grip, new tab, persistence).
HARNESS="$(cd "$(dirname "$0")" && pwd)"
BASE="$(cd "$HARNESS/.." && pwd)"
source "$HARNESS/chrome-path.sh"
trap 'pkill -f "ext-smoke-profile" 2>/dev/null' EXIT
CHROME="$(find_chrome)" || { echo "$FIND_CHROME_HINT"; exit 1; }

pkill -f "ext-smoke-profile" 2>/dev/null
sleep 1
rm -rf /tmp/ext-smoke-profile
EXT="$BASE/whiteboard/ext"
"$CHROME" --user-data-dir=/tmp/ext-smoke-profile --disable-extensions-except="$EXT" --load-extension="$EXT" --remote-debugging-port=9222 --no-first-run --no-default-browser-check --window-size=1280,900 about:blank >"$HARNESS/chrome.log" 2>&1 &
sleep 5
curl -s http://localhost:9222/json/version >/dev/null && echo "CDP up" || { echo "CDP FAILED"; exit 1; }
node "$HARNESS/smoke3.mjs"
RC=$?
pkill -f "ext-smoke-profile" 2>/dev/null
exit $RC
