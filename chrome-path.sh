#!/bin/bash
# chrome-path.sh — resolve a Chrome binary that honors --load-extension.
#
# Stable Google Chrome ignores --load-extension since ~2024, so these smoke
# tests need Chrome for Testing (or Chromium). Set CHROME=/path/to/chrome to
# override, or run `npx @puppeteer/browsers install chrome@stable`.
#
# Usage: source chrome-path.sh; CHROME="$(find_chrome)" || { echo "$FIND_CHROME_HINT"; exit 1; }

find_chrome() {
  # 1. explicit override
  if [ -n "$CHROME" ] && [ -x "$CHROME" ]; then echo "$CHROME"; return 0; fi
  # 2. Chrome for Testing in the puppeteer cache
  for d in "$HOME"/.cache/puppeteer/chrome/*/"chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"; do
    [ -x "$d" ] && { echo "$d"; return 0; }
  done
  # 3. Chrome for Testing via @puppeteer/browsers default install
  for d in "$HOME"/.cache/puppeteer/chrome/*; do
    [ -x "$d" ] && [ -x "$d/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" ] && {
      echo "$d/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"; return 0;
    }
  done
  # 4. Chromium / stable Chrome as a last resort (stable may ignore --load-extension)
  if [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
    echo "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" >&2
    echo "WARNING: using stable Chrome; it may ignore --load-extension (prefer Chrome for Testing)." >&2
    echo "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    return 0
  fi
  FIND_CHROME_HINT="No Chrome for Testing found. Install it with:  npx @puppeteer/browsers install chrome@stable"
  return 1
}
