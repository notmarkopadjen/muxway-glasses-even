#!/usr/bin/env bash
# Builds the page and the muxway hub and agent, then runs the end-to-end
# suite into test-runs/<id>/: summary.md, results.xml, report/index.html,
# logs/<test>/, screens/<test>/, traces/.
#   MUXWAY_CORE  checkout of the core repository (default: ../muxway)
#   scripts/e2e.sh [test id ...]
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
for tool in tmux Xvfb go python3 node; do
    command -v "$tool" >/dev/null || { echo "the end-to-end tests need $tool" >&2; exit 1; }
done
core=${MUXWAY_CORE:-../muxway}
[ -f "$core/go.mod" ] || { echo "no muxway core checkout at $core (set MUXWAY_CORE)" >&2; exit 1; }

scripts/build.sh >/dev/null
sim=node_modules/@evenrealities/sim-linux-x64/bin/evenhub-simulator
[ -x "$sim" ] || { echo "no simulator binary at $sim (npm ci)" >&2; exit 1; }
if ldd "$sim" | grep -q "not found"; then
    echo "the simulator needs libraries this machine lacks (libwebkit2gtk-4.1-0):" >&2
    ldd "$sim" | grep "not found" >&2
    exit 1
fi

id="$(date -u +%Y%m%d-%H%M%S)-$(git rev-parse --short HEAD)"
run="$PWD/test-runs/$id"
mkdir -p "$run"
(cd "$core" && CGO_ENABLED=0 go build -o "$run/muxway" ./cmd/muxway)
{ echo "core $(git -C "$core" rev-parse --short HEAD)"; tmux -V; node --version; echo "simulator $(node -p "require('@evenrealities/evenhub-simulator/package.json').version")"; uname -sm; } > "$run/environment.txt"

status=0
python3 -I tests/e2e/run.py "$run" "$run/muxway" "$@" || status=$?
rm -f "$run/muxway"
sed -n 3p "$run/summary.md"
echo "run directory: test-runs/$id (report: report/index.html)"
exit "$status"
