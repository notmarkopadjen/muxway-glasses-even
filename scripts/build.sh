#!/usr/bin/env bash
# Type-checks and builds the page into dist/. Needs Node 22 and `npm ci` once.
#   scripts/build.sh          the production build
#   scripts/build.sh --test   the test build: takes settings from its URL and traces pages (docs/testing.md)
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
mode=production
[ "${1:-}" = "--test" ] && mode=test
[ -d node_modules ] || npm ci --no-audit --no-fund
npx tsc --noEmit -p .
npx vite build --logLevel warn --mode "$mode"
echo "dist/ built: $(du -sh dist | cut -f1)"
