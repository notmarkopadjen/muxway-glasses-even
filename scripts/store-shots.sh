#!/usr/bin/env bash
# Takes the listing's screenshots from the simulator against the test hub:
# runs the end-to-end tests whose captures the listing uses and copies
# them into store/shots/ under the listing's names. Synthetic panes only.
#   MUXWAY_CORE=../muxway scripts/store-shots.sh            # a fresh run of the tests it needs
#   scripts/store-shots.sh test-runs/<id>                     # from a run already made
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
if [ -n "${1:-}" ]; then
    run=${1%/}
else
    scripts/e2e.sh F10 F11 F13 F14 F15 F20 F16 >/dev/null || true
    run=$(ls -td test-runs/*/ | head -1)
fi
shots="$run/screens"
mkdir -p store/shots
pick() { local from; from=$(ls "$shots"/$1/*-$2.png 2>/dev/null | head -1); [ -n "$from" ] && cp "$from" "store/shots/$3" && echo "store/shots/$3"; }
pick F10_f10 panes 01-panes.png
pick F15_f15 panes-attention 02-panes-attention.png
pick F11_f11 pane-hello 03-pane.png
pick F14_f14 lens 04-lens.png
pick F13_f13 answers 05-answers.png
pick F13_f13 confirm 06-confirm.png
pick F20_f20 meter 07-listening.png
pick F20_f20 heard 08-heard.png
pick F15_f15 toast 09-toast.png
pick F16_f16 tested-phone 10-phone.png
python3 scripts/check-listing.py
