# Multi-input selection sweep. Pool, ops and concurrency FIXED; only the number
# of holdings each transfer must gather varies (1, 2, 4, 8).
#
# PREDICTION, recorded before the runs: if contention is a bookkeeping effect,
# gathering k inputs both consumes the pool k times faster and takes k chances
# of landing on something already spent, so contention should rise roughly with
# k. A k-input transfer out of a pool of 1200 should behave about like a
# single-input transfer out of a pool of 1200/k.
#
#   f = (k * ops) / pool,  contention ~= f / 2
#   k=1: f=0.10 -> ~5.0%
#   k=2: f=0.20 -> ~10.0%
#   k=4: f=0.40 -> ~20.0%
#   k=8: f=0.80 -> ~40.0%
#
# Inputs are drawn with "$ref:holdings[*!]" — random WITHOUT replacement within
# a submission — so a transfer can never nominate the same holding twice. With
# plain "[*]" that self-duplicate would fail for reasons unrelated to
# contention, and would get likelier as k grows: an artifact with the same
# shape as the effect under test.


# Paths come from the environment so this runs anywhere. Set before running:
#   $env:CS_JDK    = path to a JDK 21   (e.g. the one bundled with your Daml SDK)
#   $env:CS_OZ_DAR = built simple-token DAR from OpenZeppelin/canton-token-template
#   $env:CS_STD_DAR= built std-spike DAR (the minimal reference registry)
$ErrorActionPreference = "Continue"
$repo = (Resolve-Path "$PSScriptRoot\..\..\..\..").Path
$dar  = $env:CS_OZ_DAR
$jdk  = $env:CS_JDK
$out  = "$repo\examples\openzeppelin\multiinput\results"

New-Item -ItemType Directory -Force -Path $out | Out-Null
Set-Location $repo

foreach ($k in @(1, 2, 4, 8)) {
  Write-Output "===== RUN: $k input(s) per transfer ====="
  $started = Get-Date
  node src/cli.ts run $dar `
    --workload-file "examples/openzeppelin/multiinput/inputs-$k.json" `
    --model closed --concurrency 8 --ops 120 `
    --sandbox --java-home $jdk `
    --report "$out\inputs-$k.json" 2>&1 | Out-String -Width 200
  $secs = [math]::Round(((Get-Date) - $started).TotalSeconds)
  Write-Output "===== DONE: $k input(s) in ${secs}s ====="
}

Write-Output "ALL MULTI-INPUT RUNS COMPLETE"
