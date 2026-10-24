#!/usr/bin/env bash
# Packs the app for the Even Hub portal with your hub in the manifest's
# network whitelist, which is the only host the Even app lets it reach.
#   scripts/pack.sh https://hub.example.com [package id] [out.ehpk]
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
hub=${1:?hub URL, e.g. https://hub.example.com}
id=${2:-com.example.muxway}
out=${3:-muxway.ehpk}
case "$hub" in https://*) ;; *) echo "the hub must be https" >&2; exit 1;; esac
scripts/build.sh
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
python3 - "$hub" "$id" "$tmp/app.json" <<'PY'
import json, sys, urllib.parse
hub, pid, out = sys.argv[1:4]
u = urllib.parse.urlsplit(hub)
m = json.load(open("app.json"))
m["package_id"] = pid
for p in m["permissions"]:
    if p["name"] == "network":
        p["whitelist"] = [f"{u.scheme}://{u.netloc}"]
json.dump(m, open(out, "w"), indent=2)
PY
npx evenhub pack "$tmp/app.json" dist -o "$out" --sdk-ver "$(node -p "require('./node_modules/@evenrealities/even_hub_sdk/package.json').version")"
echo "packed $out for $hub"
