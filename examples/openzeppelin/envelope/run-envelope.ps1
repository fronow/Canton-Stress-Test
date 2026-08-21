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


# Paths come from the environment so this runs anywhere. Set before running:
#   $env:CS_JDK    = path to a JDK 21   (e.g. the one bundled with your Daml SDK)
#   $env:CS_OZ_DAR = built simple-token DAR from OpenZeppelin/canton-token-template
#   $env:CS_STD_DAR= built std-spike DAR (the minimal reference registry)
$ErrorActionPreference = "Continue"
$repo = (Resolve-Path "$PSScriptRoot\..\..\..\..").Path
$jdk  = $env:CS_JDK
$out  = "$repo\examples\openzeppelin\envelope"

New-Item -ItemType Directory -Force -Path $out | Out-Null
Set-Location $repo

$targets = @(
  @{ name = "std-spike";    dar = $env:CS_STD_DAR },
  @{ name = "simple-token"; dar = $env:CS_OZ_DAR }
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
