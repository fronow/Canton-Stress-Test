# Pool-turnover sweep. Concurrency and ops FIXED; only pool depth varies.
# Predicts contention halves each time the pool doubles: ~50 / 25 / 12.5 / 6.3%.


# Paths come from the environment so this runs anywhere. Set before running:
#   $env:CS_JDK    = path to a JDK 21   (e.g. the one bundled with your Daml SDK)
#   $env:CS_OZ_DAR = built simple-token DAR from OpenZeppelin/canton-token-template
#   $env:CS_STD_DAR= built std-spike DAR (the minimal reference registry)
$ErrorActionPreference = "Continue"
$repo = (Resolve-Path "$PSScriptRoot\..\..\..\..").Path
$dar  = $env:CS_OZ_DAR
$jdk  = $env:CS_JDK
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
