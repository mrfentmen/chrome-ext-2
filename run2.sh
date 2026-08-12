#!/bin/bash
# One-shot smoke2 run: launch Chrome for Testing with all 9 extensions (live
# ext folders = freshly pushed build), run the interaction-flow suite, clean up.
HARNESS="/Users/del/Desktop/REALESED EXT/smoke-harness"
BASE="${SMOKE_BASE:-/Users/del/Desktop/REALESED EXT}"
source "$HARNESS/chrome-path.sh"
trap 'pkill -f "ext-smoke-profile" 2>/dev/null' EXIT
CHROME="$(find_chrome)" || { echo "$FIND_CHROME_HINT"; exit 1; }

pkill -f "ext-smoke-profile" 2>/dev/null
sleep 1
rm -rf /tmp/ext-smoke-profile

EXTS=""
for d in random-fact-generator image-to-pdf where-is-iss wiki-instant image-resize-compressor whiteboard internet-radio-player hacker-news-reader pokemon-price-ticker yugioh-price-ticker sports-card-ticker; do
  EXTS="$EXTS,$BASE/$d/ext"
done
EXTS="${EXTS#,}"

"$CHROME" \
  --user-data-dir=/tmp/ext-smoke-profile \
  --disable-extensions-except="$EXTS" \
  --load-extension="$EXTS" \
  --headless=new --disable-session-crashed-bubble --remote-debugging-port=9222 \
  --no-first-run --no-default-browser-check \
  --window-size=1280,900 \
  about:blank >"$HARNESS/chrome.log" 2>&1 &

sleep 5
curl -s http://localhost:9222/json/version >/dev/null && echo "CDP up" || { echo "CDP FAILED"; head -20 "$HARNESS/chrome.log"; exit 1; }
node "$HARNESS/smoke2.mjs"
RC=$?
pkill -f "ext-smoke-profile" 2>/dev/null
exit $RC
