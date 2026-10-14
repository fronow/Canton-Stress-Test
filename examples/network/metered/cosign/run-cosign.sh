#!/usr/bin/env bash
# Measure a CoAsset transfer for each case below: create the co-signer parties
# on the listed extra participants, write that case's workload, measure it.
# Case spec: name|cosigner hosts, where cosigner hosts is a ;-separated list,
# one entry per co-signer, each a ,-separated list of EXTRA participant numbers
# ("-" = hosted on participant1 only). Example: "c2-same|2;2", "local2|-;-".
# Needs four-participants.conf running with the cosign DAR on every node.
# Usage: bash run-cosign.sh "c0|" "c1-sep|2" ...
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../../.." && pwd)"
JAVA="${JAVA:-java}"
CANTON_JAR="${CANTON_JAR:-$APPDATA/daml/sdk/3.4.11/canton/canton.jar}"
REMOTE="${REMOTE:-remote-4.conf}"
mkdir -p "$here/../results"
for spec in "$@"; do
  name="${spec%%|*}"; hosts="${spec#*|}"
  roleargs=(); cos=(); i=0
  IFS=';' read -ra entries <<< "$hosts"
  [ -z "$hosts" ] && entries=()
  for extra in "${entries[@]}"; do
    [ "$extra" = "-" ] && extra=""
    i=$((i+1))
    sed -e "s/__NAME__/cosigner$i/" -e "s/__EXTRA__/$extra/" "$here/multihost-party.canton.tmpl" > "$here/../results/party.canton"
    pid=$(cd "$here/../.." && "$JAVA" -Xmx512m -jar "$CANTON_JAR" run metered/results/party.canton -c "$REMOTE" --no-tty 2>&1 \
          | tr -d '\r' | grep -oE "PARTY=\S+" | cut -d= -f2)
    rm -f "$here/../results/party.canton"
    [ -z "$pid" ] && { echo "$name: could not create cosigner $i"; exit 1; }
    roleargs+=("--role-party" "c$i=$pid"); cos+=("\$role:c$i")
  done
  wf="$here/../results/cosign-$name.json"
  node -e '
    const fs=require("fs");const w=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const cos=JSON.parse(process.argv[2]);
    w.setup[0].op.args.cosigners=cos; w.setup[0].actAs=["$role:issuer",...cos];
    fs.writeFileSync(process.argv[3],JSON.stringify(w,null,2));' "$here/cosign-transfer.json" "$(node -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- "${cos[@]}")" "$wf"
  args=$(node -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- "${roleargs[@]}")
  (cd "$repo" && CASE_NAME="cosign-$name" CASE_FILE="$wf" CASE_ARGS="$args" CASE_NODES=1 \
     CASE_WHAT="CoAsset transfer, cosigners hosted: [$hosts]" node examples/network/metered/measure-table.cjs "cosign-$name")
done
