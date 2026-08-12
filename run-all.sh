#!/bin/bash
# run-all.sh — launch Chrome for Testing with all 9 extensions and run the
# CDP smoke test (smoke.mjs) in one process. Screenshots land in ./shots.
HARNESS="$(cd "$(dirname "$0")" && pwd)"
BASE="${SMOKE_BASE:-$(cd "$HARNESS/.." && pwd)}"  # SMOKE_BASE overrides the extension root (e.g. a zip-extraction dir)
source "$HARNESS/chrome-path.sh"
CHROME="$(find_chrome)" || { echo "$FIND_CHROME_HINT"; exit 1; }

pkill -f "ext-smoke-profile" 2>/dev/null
sleep 1
rm -rf /tmp/ext-smoke-profile

EXTS=""
for d in random-fact-generator image-to-pdf where-is-iss wiki-instant image-resize-compressor whiteboard internet-radio-player hacker-news-reader pokemon-price-ticker; do
  EXTS="$EXTS,$BASE/$d/ext"
done
EXTS="${EXTS#,}"

"$CHROME" \
  --user-data-dir=/tmp/ext-smoke-profile \
  --disable-extensions-except="$EXTS" \
  --load-extension="$EXTS" \
  --remote-debugging-port=9222 \
  --no-first-run --no-default-browser-check \
  --window-size=1280,900 \
  about:blank >"$HARNESS/chrome.log" 2>&1 &

sleep 5
curl -s http://localhost:9222/json/version >/dev/null && echo "CDP up" || { echo "CDP FAILED"; cat "$HARNESS/chrome.log" | head; exit 1; }
node "$HARNESS/smoke.mjs"
RC=$?
pkill -f "ext-smoke-profile" 2>/dev/null
exit $RC
