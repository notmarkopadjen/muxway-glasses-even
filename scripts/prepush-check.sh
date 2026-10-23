#!/usr/bin/env bash
# Run before every push. Fails if the outgoing commits contain a secret or
# anything from the local deny-list. Reading the diff yourself is still required.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

upstream=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)
if [ -n "$upstream" ] && git rev-parse -q --verify "$upstream" >/dev/null; then
    range="$upstream..HEAD"
else
    range="HEAD"
fi
echo "checking $range"

if ! command -v gitleaks >/dev/null; then
    echo "gitleaks is not installed: https://github.com/gitleaks/gitleaks" >&2
    exit 1
fi
gitleaks git --no-banner --redact --log-opts="$range" .

# .denylist is local and never committed: one pattern per line (extended
# regex, case-insensitive) for the owner's own hosts, domains, numbers, names.
if [ -f .denylist ]; then
    hits=$(git log -p --format='commit %H%n%an <%ae>%n%B' "$range" \
        | grep -nEi -f <(grep -vE '^\s*(#|$)' .denylist) || true)
    if [ -n "$hits" ]; then
        echo "deny-list matches in outgoing commits:" >&2
        echo "$hits" >&2
        exit 1
    fi
else
    echo "warning: no .denylist; only the secret scan ran" >&2
fi
echo "clean"
