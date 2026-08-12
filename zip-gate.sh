#!/bin/bash
# zip-gate.sh — one-command pre-upload gate for the REALESED EXT family.
#
# Extracts every extension's upload.zip into a throwaway .zip-e2e/ directory
# (wiped each run) and runs the full documented verification suite against
# the EXTRACTED files — not the live ext/ folders — so what gets tested is
# exactly what gets uploaded:
#
#   ./run-all.sh      all 11 extensions load clean (zero console/net errors)
#   ./run5.sh         whiteboard zoom/size inputs + editor resize grips
#   ./run6.sh         viewer-popup resize grips (map / story list / article)
#   ./run-offline.sh  two-phase offline fallback (7 offline-capable)
#
# Usage:
#   ./zip-gate.sh               full gate: extract zips, then the 4 suites
#   ./zip-gate.sh --reload      skip extraction; re-run suites against the
#                               existing .zip-e2e/ (fast iteration)
#   ./zip-gate.sh --run2        also run the 11 interaction flows (run2.sh)
#   ./zip-gate.sh run5 run6     run only the named suites (any runner works)
#   ./zip-gate.sh --help        this usage
#
# Every suite launches Chrome headless and each runner cleans up after
# itself, even on crash. Exit codes: 0 = all selected suites passed,
# 1 = at least one suite failed, 2 = usage/setup error.
#
# Known flake: the run-offline suite's PokéTicker phase needs live data from
# pokemontcg.io, which has documented multi-minute 5xx bursts. The extension
# degrades exactly as designed during those; re-run the gate when the feed is
# healthy (the other six offline phases use independent feeds).

HARNESS="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HARNESS/.." && pwd)"        # REALESED EXT family root
EXTRACT="$ROOT/.zip-e2e"                 # symlink-free, wiped every run

EXTS=(random-fact-generator image-to-pdf where-is-iss wiki-instant
      image-resize-compressor whiteboard internet-radio-player hacker-news-reader
      pokemon-price-ticker yugioh-price-ticker sports-card-ticker)

RELOAD=0
RUN2=0
GATES=()

usage() { sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; }

for arg in "$@"; do
  case "$arg" in
    --help|-h) usage; exit 0 ;;
    --reload)  RELOAD=1 ;;
    --run2)    RUN2=1 ;;
    --*)       echo "zip-gate: unknown flag '$arg' (try --help)" >&2; exit 2 ;;
    audit|run-all|run2|run3|run4|run5|run6|run-offline) GATES+=("$arg") ;;
    *)         echo "zip-gate: unknown suite '$arg' (try --help)" >&2; exit 2 ;;
  esac
done

if [ "${#GATES[@]}" -eq 0 ]; then
  GATES=(audit run-all run5 run6 run-offline)
fi
if [ "$RUN2" = 1 ] && [[ ! " ${GATES[*]} " =~ " run2 " ]]; then
  GATES+=(run2)
fi

# ---------- extract (or reuse) the zips ----------
if [ "$RELOAD" = 1 ]; then
  echo "zip-gate: --reload — reusing $EXTRACT"
else
  rm -rf "$EXTRACT"
  missing=0
  for d in "${EXTS[@]}"; do
    z="$ROOT/$d/upload.zip"
    if [ ! -f "$z" ]; then
      echo "[MISSING] $d/upload.zip" >&2
      missing=1
      continue
    fi
    mkdir -p "$EXTRACT/$d/ext"
    unzip -qo "$z" -d "$EXTRACT/$d/ext"
  done
  [ "$missing" = 1 ] && { echo "zip-gate: build the missing upload.zips first." >&2; exit 1; }
  echo "zip-gate: extracted ${#EXTS[@]} upload.zips -> $EXTRACT"
fi

# sanity: every suite dir must exist in the extraction
for d in "${EXTS[@]}"; do
  if [ ! -f "$EXTRACT/$d/ext/manifest.json" ]; then
    echo "zip-gate: $EXTRACT/$d/ext/manifest.json missing — zip incomplete for $d" >&2
    exit 1
  fi
done

source "$HARNESS/chrome-path.sh"
CHROME="$(find_chrome)" || { echo "$FIND_CHROME_HINT"; exit 2; }
echo "zip-gate: chrome = $CHROME"
echo "zip-gate: suites = ${GATES[*]}"

# ---------- run the suites against the extracted zips ----------
fails=0
for gate in "${GATES[@]}"; do
  echo
  echo "========== zip-gate: $gate (against $EXTRACT) =========="
  SMOKE_BASE="$EXTRACT" bash "$HARNESS/$gate.sh"
  rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "zip-gate: $gate PASS"
  else
    echo "zip-gate: $gate FAIL (exit $rc)" >&2
    fails=$((fails + 1))
  fi
done

echo
if [ "$fails" -eq 0 ]; then
  echo "=== zip-gate OVERALL: ALL ${#GATES[@]} SUITES PASS ==="
  exit 0
fi
echo "=== zip-gate OVERALL: $fails/${#GATES[@]} SUITES FAILED ===" >&2
echo "(note: run-offline can fail on upstream feed outages — re-run when healthy)" >&2
exit 1
