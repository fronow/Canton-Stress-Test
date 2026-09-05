# Input-selection strategy sweep: random vs per-submission reservation,
# at two concurrency levels. One wallet throughout; pool sized to 4x ops.


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
