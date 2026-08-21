# Does the per-stakeholder cost hold on the TRANSFER path?
#
# The 175.5 B/observer slope was measured on a CREATE of a small factory. The
# headline claim ("about a cent per stakeholder") is only safe if it also holds
# for the transaction people actually care about — a standard transfer.
#
# std-spike's factory carries `users : [Party]` as its observer list, and those
# observers are stakeholders of the contract the transfer exercises, so they are
# informees of the transfer. Varying the party count therefore varies the
# transfer's informee count while sender ($p0), receiver ($p1) and the holding
# pool stay exactly the same.
#
# PREDICTION, recorded before running: if the per-informee cost is a property of
# the protocol rather than of the transaction, the slope should again be about
# 175 B per observer, on a much larger base (~11.7 KB rather than ~878 B).
# A materially different slope would mean the cent-per-stakeholder figure does
# not generalise, and the post has to say so.


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

foreach ($n in 2, 4, 8, 16, 32) {
  Write-Output "===== transfer with $n parties ====="
  node src/cli.ts $dar `
    --java-home $jdk `
    --set-json parties=$n --set-json holdings=40 `
    --ops 8 --concurrency 4 `
    --traffic-price 60 `
    --report "$out\xfer-informee-$n.json" 2>&1 |
    Select-String -Pattern "envelope size|ops:" | Out-String -Width 200
}

Write-Output "ALL TRANSFER-INFORMEE RUNS COMPLETE"
