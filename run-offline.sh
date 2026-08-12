#!/bin/bash
# run-offline.sh — two-phase offline-fallback regression for the three
# cache-backed extensions (hacker-news-reader, wiki-instant,
# internet-radio-player).
#
# Phase 1: loads real data and persists each extension's cache into the
# profile. Phase 2: fails every API request via CDP and proves the saved copy
# still renders with an "Offline — saved …" status (see offline.mjs).
# The profile is NOT wiped between phases — only at the start of the run.
HARNESS="$(cd "$(dirname "$0")" && pwd)"
BASE="${SMOKE_BASE:-$(cd "$HARNESS/.." && pwd)}"  # SMOKE_BASE overrides the extension root (e.g. a zip-extraction dir)
source "$HARNESS/chrome-path.sh"
CHROME="$(find_chrome)" || { echo "$FIND_CHROME_HINT"; exit 1; }

pkill -f "ext-smoke-profile" 2>/dev/null
sleep 1
rm -rf /tmp/ext-smoke-profile

EXTS=""
for d in random-fact-generator where-is-iss hacker-news-reader wiki-instant internet-radio-player; do
  EXTS="$EXTS,$BASE/$d/ext"
done
EXTS="${EXTS#,}"

"$CHROME" \
  --user-data-dir=/tmp/ext-smoke-profile \
  --disable-extensions-except="$EXTS" \
  --load-extension="$EXTS" \
  --remote-debugging-port=9222 \
  --no-first-run --no-default-browser-check \
  --window-size=1200,800 \
  about:blank >"$HARNESS/chrome-offline.log" 2>&1 &

sleep 5
curl -s http://localhost:9222/json/version >/dev/null && echo "CDP up" || { echo "CDP FAILED"; cat "$HARNESS/chrome-offline.log" | head; exit 1; }
node "$HARNESS/offline.mjs"
RC=$?
pkill -f "ext-smoke-profile" 2>/dev/null
exit $RC
