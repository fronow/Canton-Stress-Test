# Envelope-size stability check, then the cross-registry comparison.
#
# Envelope size is measured by ONE prepare call per distinct operation, before
# the measured window. So unlike a latency percentile it is not a sample from a
# noisy distribution — it should be a property of the transaction's shape. This
# script exists to CHECK that rather than assume it: three runs per registry,
# identical settings, and the per-operation byte count compared across them.
#
# Both arms use the same library workload, the same party count and the same
# single-input transfer, so the only thing differing is the registry.

$ErrorActionPreference = "Continue"
$repo = "E:\canton-daml\canton-stress"
$jdk  = "E:\canton-daml\tools\jdk-21.0.11+10"
$out  = "$repo\examples\openzeppelin\envelope"

New-Item -ItemType Directory -Force -Path $out | Out-Null
Set-Location $repo

$targets = @(
  @{ name = "std-spike";    dar = "E:/sp/.daml/dist/std-spike-0.1.0.dar" },
  @{ name = "simple-token"; dar = "E:/ozt/simple-token/.daml/dist/simple-token-0.1.0.dar" }
)

foreach ($t in $targets) {
  foreach ($i in 1, 2, 3) {
    Write-Output "===== $($t.name) run $i ====="
    node src/cli.ts $t.dar `
      --java-home $jdk `
      --ops 20 --set-json holdings=60 `
      --traffic-price 60 `
      --report "$out\$($t.name)-$i.json" 2>&1 |
      Select-String -Pattern "envelope size|at \$60/MB|ops:" | Out-String -Width 200
  }
}

Write-Output "ALL ENVELOPE RUNS COMPLETE"
