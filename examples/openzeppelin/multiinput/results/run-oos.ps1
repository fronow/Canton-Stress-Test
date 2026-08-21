# Out-of-sample test of the multi-input contention model.
#
# The predictions for these three runs are recorded in
# examples/openzeppelin/multiinput/PREDICTIONS.md BEFORE this script is run:
#
#   oos-k3         k=3, pool 1200  ->  28.8%   (linear model says 15%)
#   oos-k6         k=6, pool 1200  ->  56.6%   (linear model says 30%)
#   oos-k4-pool2x  k=4, pool 2400  ->  26.3%   (linear model says 10%)
#
# The third run moves the POOL rather than k, so the two variables are
# separated instead of being confounded as they are in round 1.

$ErrorActionPreference = "Continue"
$repo = "E:\canton-daml\canton-stress"
$dar  = "E:/ozt/simple-token/.daml/dist/simple-token-0.1.0.dar"
$jdk  = "E:\canton-daml\tools\jdk-21.0.11+10"
$out  = "$repo\examples\openzeppelin\multiinput\results"

New-Item -ItemType Directory -Force -Path $out | Out-Null
Set-Location $repo

foreach ($run in @("oos-k3", "oos-k6", "oos-k4-pool2x")) {
  Write-Output "===== RUN: $run ====="
  $started = Get-Date
  node src/cli.ts run $dar `
    --workload-file "examples/openzeppelin/multiinput/$run.json" `
    --model closed --concurrency 8 --ops 120 `
    --sandbox --java-home $jdk `
    --report "$out\$run.json" 2>&1 | Out-String -Width 200
  $secs = [math]::Round(((Get-Date) - $started).TotalSeconds)
  Write-Output "===== DONE: $run in ${secs}s ====="
}

Write-Output "ALL OUT-OF-SAMPLE RUNS COMPLETE"
