# Smoke Harness — pre-upload verification for the REALESED EXT family

Runs every extension's popup in a **real browser** (Chrome for Testing + CDP,
zero npm dependencies) and checks for console errors, uncaught exceptions,
failed/blocked network requests, and that key UI state renders. Screenshots of
each popup land in `shots/`.

Every runner launches Chrome **headless** (`--headless=new`) with a throwaway
profile in `/tmp`, so nothing ever appears on your screen, and a `trap` kills
the browser on exit — even when a run crashes — so no orphaned windows can
linger.

## Why Chrome for Testing?

Stable Google Chrome ignores the `--load-extension` flag (since ~2024), so the
harness needs **Chrome for Testing** or Chromium. The runner auto-discovers it:

- Set `CHROME=/path/to/chrome` to override, or
- Install it once with: `npx @puppeteer/browsers install chrome@stable`

## Usage (from this folder)

| Command | What it verifies |
|---|---|
| `./run-all.sh` | **The big one** — all 11 extensions load clean (zero console/net errors) + key DOM state; saves screenshots |
| `./run3.sh` | Whiteboard: corner-drag resize, New tab button, tab auto-fit, persistence |
| `./run4.sh` | Whiteboard: store screenshot regeneration (`ext/store/screenshot.png`) + header fits |
| `./run5.sh` | Whiteboard zoom (50%/100%/Fit), exact size inputs, zoom-aware grip; editor grips on image-to-pdf + image-resize-compressor; zero console errors |
| `./run6.sh` | Corner-drag grips on where-is-iss (map), hacker-news-reader (story list) and wiki-instant (article text): drag math, keyboard arrows, persistence, zero console errors |
| `./run-offline.sh` | **Two-phase offline regression** for the 7 offline-capable extensions (fact generator kept fact, ISS last fix + STALE badge, HN stories, wiki article, radio stations, PokéTicker + DuelTicker cached card quotes): phase 1 loads real data + saves the cache, phase 2 fails every API request via CDP and proves the saved copy renders with an "Offline — saved …" status and zero uncaught exceptions |
| `./run2.sh` | Interaction flows across all 11 popups: new fact, PDF convert, ISS refresh, wiki search, resize estimate, undo, radio play, HN tabs, PokéTicker + DuelTicker search→add→quote, SportsTicker token setup→test→save (token-gated: a fake token must produce a completed verdict from the real eBay request path) |
| `./zip-gate.sh` | **One-command pre-upload gate** — extracts every `upload.zip` into `.zip-e2e/` and runs audit + run-all + run5 + run6 + run-offline against the extracted files (`--run2` adds the interaction flows) |
| `./audit.sh` | Static pre-submission checklist: manifest validity, zip integrity, screenshot dims, store description presence — all 11 extensions |

Each runner exits non-zero on failure, so it can be dropped into a pre-release
script.

## What counts as a failure

A popup fails if it logs any **console error**, throws an **uncaught
exception**, has any **failed network request**, or its key DOM state is
missing. Known benign noise: internet-radio-player's station **favicons** — a
station server returning 402/blocked by ORB logs one console error; the code
already falls back to a radio emoji and playback is unaffected.

**pokemontcg.io flakiness:** the PokéTicker offline phase needs live data to
cache, and the Pokemon TCG API has had multi-minute outages (intermittent
500/502 on all endpoints, confirmed via curl). During one, the PokéTicker
phase fails — the extension degrades exactly as designed (3-try retry ladder,
honest feed-down messages, cached quotes when any exist), and the phase goes
green again once the feed is healthy. The other five offline phases use
independent feeds and are unaffected.

## Files

- `audit.sh` — static pre-submission checklist (manifest/zip/screenshot/docs)
- `run-all.sh`, `run2.sh`, `run3.sh`, `run4.sh`, `run5.sh`, `run6.sh`,
  `run-offline.sh` — one-shot runners (launch headless Chrome, run a test,
  report, clean up)
- `zip-gate.sh` — one-command pre-upload gate: extracts every `upload.zip`
  into `.zip-e2e/` and runs the suites against the extracted files
- `audit.py` — the audit engine (manifest/zip/icons/screenshot/docs checks for all 11 extensions; respects SMOKE_BASE for zip-gate)
- `chrome-path.sh` — Chrome for Testing discovery (override with `CHROME=`)
- `smoke.mjs` — load test + screenshots for all 11 extensions
- `smoke2.mjs` — interaction flows
- `smoke3.mjs` / `smoke5.mjs` — whiteboard + editor feature E2E
- `offline.mjs` — two-phase offline-fallback regression (cache-backed
  extensions)
- `smoke4.mjs` — store screenshot regen
- `gen-privacy.mjs` — regenerate the 8 privacy policy pages into
  `../privacy-policies` (the GitHub Pages repo checkout); commit + push to
  deploy

## Verifying the upload.zips (pre-upload gate)

One command: extract every `upload.zip` into a throwaway `.zip-e2e/` and run
the whole gate against the **extracted files** — not the live `ext/` folders —
so what gets tested is exactly what gets uploaded:

```bash
./zip-gate.sh                # full gate: audit + run-all + run5 + run6 + run-offline
./zip-gate.sh --run2         # + the 11 interaction flows
./zip-gate.sh run5 run6      # just the named suites
./zip-gate.sh --reload       # re-run against the existing .zip-e2e/ (no re-extract)
```

The gate wipes `.zip-e2e/` on every run, reports each suite's PASS/FAIL, and
exits non-zero if any suite failed. `run-offline` can fail on upstream feed
outages (pokemontcg.io is documented flaky) — re-run when the feed is healthy.

**Gotcha:** extension IDs are the SHA-256 of the load path, and Chrome
canonicalizes symlinks before hashing. On macOS `/tmp` is a symlink to
`/private/tmp`, so extracting to `/tmp/...` makes Chrome's IDs differ from the
harness's — every popup then resolves to an error page. `zip-gate.sh` always
extracts to `.zip-e2e/` inside the family root, which is symlink-free.

## Notes

- The extension IDs are derived from the absolute path of each `ext/` folder
  (same algorithm Chrome uses), so the harness only works when the extensions
  stay at `../<name>/ext` relative to this folder — which is how the family is
  laid out.
- `SMOKE_BASE=/path/to/root` overrides the extension root for any runner.
- The profile is created in `/tmp` and wiped on every run.
