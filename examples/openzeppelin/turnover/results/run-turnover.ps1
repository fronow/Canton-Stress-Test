# Pool-turnover sweep. Concurrency and ops FIXED; only pool depth varies.
# Predicts contention halves each time the pool doubles: ~50 / 25 / 12.5 / 6.3%.

$ErrorActionPreference = "Continue"
$repo = "E:\canton-daml\canton-stress"
$dar  = "E:/ozt/simple-token/.daml/dist/simple-token-0.1.0.dar"
$jdk  = "E:\canton-daml\tools\jdk-21.0.11+10"
$out  = $PSScriptRoot

New-Item -ItemType Directory -Force -Path $out | Out-Null
Set-Location $repo

foreach ($m in @("1x","2x","4x","8x")) {
  Write-Output "===== RUN: pool $m ====="
  $started = Get-Date
  node src/cli.ts run $dar `
    --workload-file "examples/openzeppelin/turnover/pool-$m.json" `
    --model closed --concurrency 8 --ops 240 `
    --sandbox --java-home $jdk `
    --report "$out\pool-$m.json" 2>&1 | Out-String -Width 200
  $secs = [math]::Round(((Get-Date) - $started).TotalSeconds)
  Write-Output "===== DONE: pool $m in ${secs}s ====="
}

Write-Output "ALL TURNOVER RUNS COMPLETE"
