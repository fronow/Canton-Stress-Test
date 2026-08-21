# Informee-scaling sweep: does envelope size grow with the number of
# stakeholders? Only the observer count varies; the payload is identical.
#
# PREDICTION recorded before running (see BENCHMARK-ENVELOPE.md): if the
# confirmation request carries encrypted views per informee, prepared size
# should grow roughly linearly with N. If prepared size is flat, the
# per-informee cost lives downstream of prepare and the envelope figure is a
# lower bound that misses it.


# Paths come from the environment so this runs anywhere. Set before running:
#   $env:CS_JDK    = path to a JDK 21   (e.g. the one bundled with your Daml SDK)
#   $env:CS_OZ_DAR = built simple-token DAR from OpenZeppelin/canton-token-template
#   $env:CS_STD_DAR= built std-spike DAR (the minimal reference registry)
$ErrorActionPreference = "Continue"
$repo = (Resolve-Path "$PSScriptRoot\..\..\..\..").Path
$jdk  = $env:CS_JDK
$dar  = $env:CS_STD_DAR
$out  = "$repo\examples\openzeppelin\envelope"

Set-Location $repo

foreach ($n in 1, 2, 4, 8, 16, 32) {
  Write-Output "===== informees: $($n + 1) ($n observers) ====="
  node src/cli.ts run $dar `
    --workload-file "examples/openzeppelin/envelope/informee-$n.json" `
    --model closed --concurrency 4 --ops 8 `
    --sandbox --java-home $jdk `
    --traffic-price 60 `
    --report "$out\informee-result-$n.json" 2>&1 |
    Select-String -Pattern "envelope size|ops:" | Out-String -Width 200
}

Write-Output "ALL INFORMEE RUNS COMPLETE"
