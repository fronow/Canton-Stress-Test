#!/usr/bin/env bash
# One command for the large-network DSO series: generate an N-participant
# metered network, boot it, upload the Amulet DAR to every participant, then
# measure an Amulet transfer with the DSO hosted on each K in KS.
#
#   N=43 KS="1 8 16 24 32 43" OPS=30 bash run-scale.sh
#
# Needs: java (21), node (>= 23.6), the Canton jar (CANTON_JAR) and the
# splice-amulet DAR (AMULET_DAR). Results land in ../results/ exactly as for
# the local runs; the network log in ./canton-N.log. See README.md here.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
net="$(cd "$here/../.." && pwd)"
repo="$(cd "$net/../.." && pwd)"
N="${N:-43}"
KS="${KS:-1 8 16 24 32 43}"
OPS="${OPS:-30}"
JAVA="${JAVA:-java}"
CANTON_JAR="${CANTON_JAR:?set CANTON_JAR to the canton.jar from Daml SDK 3.4.11}"
AMULET_DAR="${AMULET_DAR:?set AMULET_DAR to splice-amulet-0.1.23.dar}"
HEAP="${HEAP:-$(( (N * 6 + 9) / 10 + 2 ))g}"   # ~0.6 GB per participant + 2 GB
log="$here/canton-$N.log"

echo "== generating a $N-participant network"
(cd "$net" && node gen-network.cjs "$N")

echo "== booting it with -Xmx$HEAP (log: $log)"
cd "$net"
"$JAVA" "-Xmx$HEAP" -jar "$CANTON_JAR" daemon -c "participants-$N.conf" \
  --bootstrap bootstrap-metered.canton --no-tty > "$log" 2>&1 &
canton_pid=$!
# Stop the network when the script ends, unless KEEP=1 (to inspect it).
[ "${KEEP:-0}" = "1" ] || trap 'kill $canton_pid 2>/dev/null || true' EXIT
cd "$here"
for _ in $(seq 1 3600); do
  grep -q "STRESSNET READY" "$log" 2>/dev/null && break
  if grep -qE "Compilation Failed|OutOfMemory|ExitFailure" "$log" 2>/dev/null; then
    echo "boot failed, see $log"; exit 1; fi
  sleep 1
done
grep -q "STRESSNET READY" "$log" || { echo "not ready after an hour, see $log"; exit 1; }
grep "STRESSNET READY" "$log"

echo "== uploading the Amulet DAR to $N participants"
for i in $(seq 1 "$N"); do
  curl -sf -X POST -H "Content-Type: application/octet-stream" \
    --data-binary @"$AMULET_DAR" "http://localhost:$((7000 + 10 * i + 1))/v2/dars" > /dev/null \
    || { echo "upload to participant $i failed"; exit 1; }
done

echo "== DSO series K in: $KS ($OPS transfers each)"
cd "$net/metered"
TAG="${TAG:-n$N}" JAVA="$JAVA" CANTON_JAR="$CANTON_JAR" REMOTE="remote-$N.conf" KS="$KS" OPS="$OPS" bash run-dso-series.sh
echo "== done; per-case rows in $net/metered/results/table-amulet-dso-*-n$N.row.json"
if [ "${KEEP:-0}" = "1" ]; then echo "   network left running (KEEP=1); stop it with: kill $canton_pid"; fi
