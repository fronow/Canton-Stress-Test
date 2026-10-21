#!/usr/bin/env bash
# Print what the sequencer has BILLED each node so far, one line per node:
#   <label> PAR::participant1 consumed=<bytes>
# Usage: read.sh <label>
# Needs the metered network running (see METERED.md). Override JAVA or
# CANTON_JAR if yours live elsewhere.
here="$(cd "$(dirname "$0")" && pwd)"
JAVA="${JAVA:-java}"
CANTON_JAR="${CANTON_JAR:-$APPDATA/daml/sdk/3.4.11/canton/canton.jar}"
cd "$here/.."
"$JAVA" -Xmx512m -jar "$CANTON_JAR" run metered/seq-state.canton -c "${REMOTE:-remote.conf}" --no-tty --log-file-name log/read-console.log 2>&1 \
  | tr -d '\r' | tr '\n' ' ' \
  | grep -oE "(MED|PAR)::[a-z0-9]+[^>]*-> Right\(TrafficState\([^)]*\)" \
  | sed -E "s/::1220[0-9a-f.]+ -> Right\(TrafficState\(.*extraTrafficConsumed = ([0-9]+).*/ consumed=\1/; s/^/$1 /"
