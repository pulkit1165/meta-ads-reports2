#!/usr/bin/env bash
# Start the astro bot. Expects .env alongside this script.
set -euo pipefail
cd "$(dirname "$0")"
PY=./.venv/bin/python
[ -x "$PY" ] || PY=python3
"$PY" store.py                # ensure schema
exec "$PY" server.py
