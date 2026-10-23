#!/usr/bin/env bash
# Records one test run as a GitHub issue labelled test-run: open while red,
# closed when green. Usage: scripts/record-run.sh <run directory>
# The run directory comes from scripts/e2e.sh: summary.md and results.xml.
set -euo pipefail
dir=${1:?run directory}
dir=${dir%/}
[ -f "$dir/results.xml" ] && [ -f "$dir/summary.md" ] || { echo "not a run directory: $dir" >&2; exit 1; }

attr() { grep -o "<testsuites[^>]*" "$dir/results.xml" | grep -o "$1=\"[0-9]*\"" | head -1 | tr -dc '0-9'; }
tests=$(attr tests); failures=$(attr failures); errors=$(attr errors); skipped=$(attr skipped)
bad=$(( ${failures:-0} + ${errors:-0} ))
result=$([ "$bad" -eq 0 ] && echo passed || echo failed)
commit=$(git rev-parse --short HEAD)
id=$(basename "$dir")

for label in test-run "run:passed" "run:failed"; do
    gh label create "$label" --force >/dev/null 2>&1 || true
done

if [ -n "${RUN_URL:-}" ]; then
    where="[workflow run]($RUN_URL); logs, screenshots and traces are its artifacts"
else
    where="local run; logs, screenshots and traces are in \`$id\` on the machine that ran it"
fi
body="| | |
|---|---|
| Result | **$result** |
| Commit | \`$commit\` |
| Tests | ${tests:-0} total, $bad failed, ${skipped:-0} skipped |
| Run | $where |

$(cat "$dir/summary.md")"
url=$(gh issue create --title "Run $id: $result @ $commit" --label test-run --label "run:$result" --body "$body")
[ "$result" = passed ] && gh issue close "$url" --reason completed >/dev/null
echo "$url"
