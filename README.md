# Smoke Harness — pre-upload verification for the REALESED EXT family

Runs every extension's popup in a **real browser** (Chrome for Testing + CDP,
zero npm dependencies) and checks for console errors, uncaught exceptions,
failed/blocked network requests, and that key UI state renders. Screenshots of
each popup land in `shots/`.

## Why Chrome for Testing?

Stable Google Chrome ignores the `--load-extension` flag (since ~2024), so the
harness needs **Chrome for Testing** or Chromium. The runner auto-discovers it:

- Set `CHROME=/path/to/chrome` to override, or
- Install it once with: `npx @puppeteer/browsers install chrome@stable`

## Usage (from this folder)

| Command | What it verifies |
|---|---|
| `./run-all.sh` | **The big one** — all 8 extensions load clean (zero console/net errors) + key DOM state; saves screenshots |
| `./run3.sh` | Whiteboard: corner-drag resize, New tab button, tab auto-fit, persistence |
| `./run4.sh` | Whiteboard: store screenshot regeneration (`ext/store/screenshot.png`) + header fits |
| `./run5.sh` | Whiteboard zoom (50%/100%/Fit), exact size inputs, zoom-aware grip; editor grips on image-to-pdf + image-resize-compressor; zero console errors |
| `./run6.sh` | Corner-drag grips on where-is-iss (map), hacker-news-reader (story list) and wiki-instant (article text): drag math, keyboard arrows, persistence, zero console errors |
| `node smoke2.mjs` | Interaction flows (needs a browser already running with `--remote-debugging-port=9222`): new fact, PDF convert, ISS refresh, wiki search, resize estimate, undo, radio play, HN tabs |

Each runner exits non-zero on failure, so it can be dropped into a pre-release
script.

## What counts as a failure

A popup fails if it logs any **console error**, throws an **uncaught
exception**, has any **failed network request**, or its key DOM state is
missing. Known benign noise: internet-radio-player's station **favicons** — a
station server returning 402/blocked by ORB logs one console error; the code
already falls back to a radio emoji and playback is unaffected.

## Files

- `run-all.sh`, `run3.sh`, `run4.sh`, `run5.sh` — one-shot runners (launch
  Chrome, run a test, report, clean up)
- `chrome-path.sh` — Chrome for Testing discovery (override with `CHROME=`)
- `smoke.mjs` — load test + screenshots for all 8 extensions
- `smoke2.mjs` — interaction flows
- `smoke3.mjs` / `smoke5.mjs` — whiteboard + editor feature E2E
- `smoke4.mjs` — store screenshot regen
- `gen-privacy.mjs` — regenerate the 8 privacy policy pages into
  `../privacy-policies` (the GitHub Pages repo checkout); commit + push to
  deploy

## Verifying the upload.zips (pre-upload gate)

Point the harness at freshly extracted zips instead of the live `ext/` folders:

```bash
BASE='/Users/del/Desktop/REALESED EXT'
mkdir -p "$BASE/.zip-e2e"
for d in random-fact-generator image-to-pdf where-is-iss wiki-instant \
         image-resize-compressor whiteboard internet-radio-player hacker-news-reader; do
  mkdir -p "$BASE/.zip-e2e/$d/ext"
  unzip -qo "$BASE/$d/upload.zip" -d "$BASE/.zip-e2e/$d/ext"
done
cd "$BASE/smoke-harness"
SMOKE_BASE="$BASE/.zip-e2e" ./run-all.sh   # full 8-extension suite against the zips
SMOKE_BASE="$BASE/.zip-e2e" ./run5.sh      # whiteboard zoom + editor grips
SMOKE_BASE="$BASE/.zip-e2e" ./run6.sh      # viewer-popup resize grips
```

**Gotcha:** extension IDs are the SHA-256 of the load path, and Chrome
canonicalizes symlinks before hashing. On macOS `/tmp` is a symlink to
`/private/tmp`, so extracting to `/tmp/...` makes Chrome's IDs differ from the
harness's — every popup then resolves to an error page. Always extract to a
symlink-free path (`.zip-e2e/` inside the project works).

## Notes

- The extension IDs are derived from the absolute path of each `ext/` folder
  (same algorithm Chrome uses), so the harness only works when the extensions
  stay at `../<name>/ext` relative to this folder — which is how the family is
  laid out.
- `SMOKE_BASE=/path/to/root` overrides the extension root for any runner.
- The profile is created in `/tmp` and wiped on every run.
