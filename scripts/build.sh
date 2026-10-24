#!/usr/bin/env bash
# Type-checks and builds the page into dist/. Needs Node 22 and `npm ci` once.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
[ -d node_modules ] || npm ci --no-audit --no-fund
npx tsc --noEmit -p .
npx vite build --logLevel warn
echo "dist/ built: $(du -sh dist | cut -f1)"
