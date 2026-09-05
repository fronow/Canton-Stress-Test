# Wallet-count scaling sweep against the OpenZeppelin token template.
# Everything constant except the number of independent sending wallets.


# Paths come from the environment so this runs anywhere. Set before running:
#   $env:CS_JDK    = path to a JDK 21   (e.g. the one bundled with your Daml SDK)
#   $env:CS_OZ_DAR = built simple-token DAR from OpenZeppelin/canton-token-template
#   $env:CS_STD_DAR= built std-spike DAR (the minimal reference registry)
$ErrorActionPreference = "Continue"
$repo = (Resolve-Path "$PSScriptRoot\..\..\..\..").Path
$dar  = $env:CS_OZ_DAR
$jdk  = $env:CS_JDK
$out  = $PSScriptRoot   # reports land next to this script

New-Item -ItemType Directory -Force -Path $out | Out-Null
Set-Location $repo

foreach ($w in @(1,2,4,8)) {
  Write-Output "===== RUN: $w wallet(s) ====="
  $started = Get-Date
  node src/cli.ts run $dar `
    --workload-file "examples/openzeppelin/scaling/wallets-$w.json" `
    --model closed --concurrency 8 --ops 120 `
    --sandbox --java-home $jdk `
    --report "$out\wallets-$w.json" 2>&1 | Out-String -Width 200
  $secs = [math]::Round(((Get-Date) - $started).TotalSeconds)
  Write-Output "===== DONE: $w wallet(s) in ${secs}s ====="
}

Write-Output "ALL RUNS COMPLETE"
