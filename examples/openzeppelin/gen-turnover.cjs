// Pool turnover: is random-selection contention a CONCURRENCY effect or a
// BOOKKEEPING effect?
//
// Hypothesis. A uniform random pick fails when it lands on a holding the wallet
// has already spent. Over a run the spent fraction of the pool grows from 0 to
// f, so the average failure rate should be about f/2 - regardless of how many
// submissions are in flight.
//
// Prediction. Fix the operations and the concurrency, vary only the pool size:
// contention should HALVE every time the pool DOUBLES.
//
//   pool  240 (1x ops)   ~43%
//   pool  480 (2x ops)   ~22%
//   pool  960 (4x ops)   ~11%
//   pool 1920 (8x ops)    ~5%
//
// Supporting evidence already in hand: at pool 960, raising concurrency from 8
// to 32 moved contention from 12.5% to 11.7% - a 4x change in concurrency for
// no change in contention.
//
//   node examples/openzeppelin/gen-turnover.cjs

const fs = require("node:fs");
const path = require("node:path");

const OPS = 240;
const MULTIPLES = [1, 2, 4, 8];

const outDir = path.join(__dirname, "turnover");
fs.mkdirSync(outDir, { recursive: true });

for (const mult of MULTIPLES) {
  const pool = OPS * mult;

  const workload = {
    _comment: [
      `Pool turnover: ${pool} holdings for ${OPS} operations (${mult}x).`,
      "",
      "One sending wallet, uniform random input selection, concurrency fixed by",
      "the runner. The ONLY variable across this sweep is pool depth, so any",
      "change in contention is a turnover effect and not a concurrency effect.",
      "",
      `Predicted contention if the hypothesis holds: about ${(50 / mult).toFixed(1)}%.`,
    ],
    version: 1,
    parties: 6,
    roles: ["admin"],
    setup: [
      {
        id: "rules",
        disclose: true,
        actAs: ["$role:admin"],
        op: {
          kind: "create",
          template: "#simple-token:SimpleToken.Rules:SimpleTokenRules",
          args: { admin: "$role:admin", supportedInstruments: ["SIMPLE"] },
        },
      },
      {
        id: "holdings",
        count: pool,
        actAs: ["$role:admin", "$p0"],
        op: {
          kind: "create",
          template: "#simple-token:SimpleToken.Holding:SimpleHolding",
          args: {
            admin: "$role:admin",
            owner: "$p0",
            instrumentId: { admin: "$role:admin", id: "SIMPLE" },
            amount: "1000.0",
            meta: { values: {} },
          },
        },
      },
    ],
    operations: [
      {
        weight: 1,
        op: {
          kind: "exercise",
          template:
            "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory",
          contract: "$ref:rules",
          choice: "TransferFactory_Transfer",
          args: {
            expectedAdmin: "$role:admin",
            transfer: {
              sender: "$p0",
              receiver: "$p1",
              amount: "1.0",
              instrumentId: { admin: "$role:admin", id: "SIMPLE" },
              requestedAt: "$now-60s",
              executeBefore: "$now+1h",
              inputHoldingCids: ["$ref:holdings[*]"],
              meta: { values: {} },
            },
            extraArgs: { context: { values: {} }, meta: { values: {} } },
          },
        },
        submit: { actAs: ["$p0"] },
      },
    ],
  };

  const file = path.join(outDir, `pool-${mult}x.json`);
  fs.writeFileSync(file, JSON.stringify(workload, null, 2) + "\n", "utf8");
  console.log(
    `${path.basename(file)}  pool ${pool} (${mult}x of ${OPS} ops)  ` +
      `predicts ~${(50 / mult).toFixed(1)}% contention`,
  );
}
