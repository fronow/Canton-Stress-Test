# Input-selection strategy sweep: random vs per-submission reservation,
# at two concurrency levels. One wallet throughout; pool sized to 4x ops.

$ErrorActionPreference = "Continue"
$repo = "E:\canton-daml\canton-stress"
$dar  = "E:/ozt/simple-token/.daml/dist/simple-token-0.1.0.dar"
$jdk  = "E:\canton-daml\tools\jdk-21.0.11+10"
$out  = $PSScriptRoot

New-Item -ItemType Directory -Force -Path $out | Out-Null
Set-Location $repo

foreach ($conc in @(8, 32)) {
  foreach ($s in @("random", "seq")) {
    Write-Output "===== RUN: $s @ concurrency $conc ====="
    $started = Get-Date
    node src/cli.ts run $dar `
      --workload-file "examples/openzeppelin/selection/$s.json" `
      --model closed --concurrency $conc --ops 240 `
      --sandbox --java-home $jdk `
      --report "$out\$s-c$conc.json" 2>&1 | Out-String -Width 200
    $secs = [math]::Round(((Get-Date) - $started).TotalSeconds)
    Write-Output "===== DONE: $s @ c$conc in ${secs}s ====="
  }
}

Write-Output "ALL SELECTION RUNS COMPLETE"
