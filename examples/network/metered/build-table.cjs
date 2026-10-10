// Combine the per-case rows from measure-table.cjs into the reference table
// (results/workload-costs.json and a Markdown table on stdout).
const fs = require("node:fs");
const path = require("node:path");
const dir = path.join(__dirname, "results");
const TYPICAL = 1_000_000 / 60; // the draft CIP's "typical" transaction, $1 at $60/MB
const order = ["oz-propose", "oz-accept", "oz-preapproved", "std-direct",
  "std-spread-2", "std-spread-4", "std-spread-8", "std-spread-16"];
const rows = order
  .map((n) => path.join(dir, `table-${n}.row.json`))
  .filter((f) => fs.existsSync(f))
  .map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
const out = rows.map((r) => {
  const sub = r.billedPerOp["PAR::participant1"];
  const other = Math.max(0, r.billedPerOp["PAR::participant2"] ?? 0);
  return {
    case: r.case, what: r.what, committed: r.committed,
    billedSubmitter: sub, billedOtherParticipant: other,
    billedMediator: r.billedPerOp["MED::mediator1"],
    billedParticipants: sub + other,
    estimateTotal: r.estimate?.total ?? null,
    estimateErrorPct: r.estimate ? +(((r.estimate.total - sub) / sub) * 100).toFixed(1) : null,
    preparedBytes: r.preparedBytes,
    billedOverPrepared: r.preparedBytes ? +((sub + other) / r.preparedBytes).toFixed(2) : null,
    typicalTx: +((sub + other) / TYPICAL).toFixed(2),
    usdAtList: +(((sub + other) * 60) / 1e6).toFixed(3),
  };
});
fs.writeFileSync(path.join(dir, "workload-costs.json"), JSON.stringify({
  measured: "2026-10-10", canton: "3.4.11", network: "metered two-participant, in memory",
  readVsWriteScalingFactor: 4, typicalTxBytes: Math.round(TYPICAL), rows: out }, null, 2));
const n = (x) => (x == null ? "—" : x.toLocaleString("en-US"));
console.log("| Case | Billed to participants | Mediator | Estimate (vs bill) | Prepared | Billed ÷ prepared | × typical | $ at list |");
console.log("|---|---|---|---|---|---|---|---|");
for (const r of out)
  console.log(`| ${r.what} | ${n(r.billedParticipants)} | ${n(r.billedMediator)} | ${n(r.estimateTotal)} (${r.estimateErrorPct}%) | ${n(r.preparedBytes)} | ${r.billedOverPrepared} | ${r.typicalTx} | $${r.usdAtList} |`);
