# Wallet-count scaling sweep against the OpenZeppelin token template.
# Everything constant except the number of independent sending wallets.

$ErrorActionPreference = "Continue"
$repo = "E:\canton-daml\canton-stress"
$dar  = "E:/ozt/simple-token/.daml/dist/simple-token-0.1.0.dar"
$jdk  = "E:\canton-daml\tools\jdk-21.0.11+10"
$out  = $PSScriptRoot

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
