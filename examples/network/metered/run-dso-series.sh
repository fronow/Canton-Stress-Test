#!/usr/bin/env bash
# For K = 1..4: create a DSO party hosted on K participants (every host must
# confirm), then measure the billed cost of an Amulet transfer with it.
# Needs the network running (four-participants.conf, or participants-N.conf
# with REMOTE=remote-N.conf) and the splice-amulet DAR uploaded to every node.
# Usage: KS="1 2 3" REMOTE=remote-8.conf bash run-dso-series.sh
here="$(cd "$(dirname "$0")" && pwd)"
JAVA="${JAVA:-java}"
CANTON_JAR="${CANTON_JAR:-$APPDATA/daml/sdk/3.4.11/canton/canton.jar}"
REMOTE="${REMOTE:-remote-4.conf}"   # remote-N.conf for an N-participant network
for K in ${KS:-1 2 3 4}; do
  sed "s/__K__/$K/" "$here/multihost-dso.canton.tmpl" > "$here/results/dso-$K.canton"
  DSO=$(cd "$here/.." && "$JAVA" -Xmx512m -jar "$CANTON_JAR" run "metered/results/dso-$K.canton" -c "$REMOTE" --no-tty --log-file-name log/dso-console.log 2>&1 \
        | tr -d '\r' | grep -oE "DSO=\S+" | cut -d= -f2)
  rm -f "$here/results/dso-$K.canton"
  [ -z "$DSO" ] && { echo "K=$K: could not create the DSO party"; exit 1; }
  echo "K=$K DSO=$DSO"
  (cd "$here/../../.." && DSO="$DSO" DSO_K="$K" node examples/network/metered/measure-table.cjs "${AMULET_CASE:-amulet}-dso-$K")
done
