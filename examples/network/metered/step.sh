#!/usr/bin/env bash
# One measurement step: run the cross-participant workload, then read what
# the sequencer billed. Billed bytes per transaction come from the DIFFERENCE
# between steps, so run a setup-only step first (see METERED.md).
# Usage: step.sh <label> [extra canton-stress args...]
here="$(cd "$(dirname "$0")" && pwd)"
label=$1; shift
mkdir -p "$here/results"
cd "$here/../../.."
node src/cli.ts run --workload-file examples/network/workload-cross-participant.json \
  --api http://localhost:7011,http://localhost:7021 --model closed --concurrency 1 --seed 1 \
  --traffic-price 60 --report "$here/results/$label.json" "$@" > "$here/results/$label.out" 2>&1
echo "== $label exit $?"
grep -E "committed|traffic|envelope|FAILED" "$here/results/$label.out" | head -8
bash "$here/read.sh" "$label"
