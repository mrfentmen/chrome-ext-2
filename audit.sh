#!/bin/bash
# audit.sh — pre-submission checklist sweep (manifest, zip, screenshot, docs).
# Runs audit.py against every extension in the REALESED EXT family.
# Respects SMOKE_BASE for zip-gate.sh (against extracted zips).
HARNESS="$(cd "$(dirname "$0")" && pwd)"
python3 "$HARNESS/audit.py"
