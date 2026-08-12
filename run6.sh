#!/bin/bash
# run6.sh — E2E for the corner-drag resize grips on where-is-iss (map),
# hacker-news-reader (story list) and wiki-instant (article text).
HARNESS="$(cd "$(dirname "$0")" && pwd)"
BASE="${SMOKE_BASE:-$(cd "$HARNESS/.." && pwd)}"
source "$HARNESS/chrome-path.sh"
CHROME="$(find_chrome)" || { echo "$FIND_CHROME_HINT"; exit 1; }

pkill -f "ext-smoke-profile" 2>/dev/null
sleep 1
rm -rf /tmp/ext-smoke-profile
EXTS="$BASE/where-is-iss/ext,$BASE/hacker-news-reader/ext,$BASE/wiki-instant/ext"
"$CHROME" --user-data-dir=/tmp/ext-smoke-profile --disable-extensions-except="$EXTS" --load-extension="$EXTS" --remote-debugging-port=9222 --no-first-run --no-default-browser-check --window-size=1280,900 about:blank >"$HARNESS/chrome.log" 2>&1 &
sleep 5
curl -s http://localhost:9222/json/version >/dev/null && echo "CDP up" || { echo "CDP FAILED"; exit 1; }
node "$HARNESS/smoke6.mjs"
RC=$?
pkill -f "ext-smoke-profile" 2>/dev/null
exit $RC
