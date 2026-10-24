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
    scripts/e2e.sh F31 F32 F33 F11 F13 F14 F15 F35 F16 >/dev/null || true
    run=$(ls -td test-runs/*/ | head -1)
fi
shots="$run/screens"
mkdir -p store/shots
pick() { local from; from=$(ls "$shots"/$1/*-$2.png 2>/dev/null | head -1); [ -n "$from" ] && cp "$from" "store/shots/$3" && echo "store/shots/$3"; }
pick F31_f31 list-attention 01-list.png
pick F32_f32 list-selected 02-selected.png
pick F33_f33 split-marked 03-split.png
pick F11_f11 pane-hello 04-pane.png
pick F14_f14 lens 05-lens.png
pick F13_f13 answers 06-answers.png
pick F35_f35 listening-graph 07-listening.png
pick F35_f35 heard-box 08-heard.png
pick F15_f15 banner 09-banner.png
pick F16_f16 tested-phone 10-phone.png
python3 scripts/check-listing.py
