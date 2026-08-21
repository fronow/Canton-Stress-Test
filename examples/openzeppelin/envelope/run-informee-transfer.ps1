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

$ErrorActionPreference = "Continue"
$repo = "E:\canton-daml\canton-stress"
$jdk  = "E:\canton-daml\tools\jdk-21.0.11+10"
$dar  = "E:/sp/.daml/dist/std-spike-0.1.0.dar"
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
