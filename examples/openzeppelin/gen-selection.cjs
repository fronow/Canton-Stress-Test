// Input-selection strategy: does HOW a wallet picks its input matter more than
// which registry it talks to?
//
// One sending wallet throughout, so wallet count is not a variable. The pool is
// sized to 4x the operations in the run, so it drains by only ~25% and pool
// depth stays roughly constant - the confound that spoiled the first
// wallet-count sweep, where a 150-holding pool fell to 30.
//
// Two strategies, identical in every other respect:
//   random  - "$ref:holdings[*]"    uniform random pick, the naive wallet
//   seq     - "$ref:holdings[seq]"  next contract in the pool, advancing once
//                                   per submission: a per-submission reservation
//
//   node examples/openzeppelin/gen-selection.cjs

const fs = require("node:fs");
const path = require("node:path");

const OPS = 240;
const POOL = 4 * OPS; // 960 - drains ~25% over the run

const outDir = path.join(__dirname, "selection");
fs.mkdirSync(outDir, { recursive: true });

for (const strategy of ["random", "seq"]) {
  const selector = strategy === "random" ? "*" : "seq";

  const workload = {
    _comment: [
      `Input-selection strategy: ${strategy}.`,
      "",
      "One sending wallet, one receiver, a pool of " + POOL + " holdings sized to 4x",
      "the " + OPS + " operations so pool depth stays roughly constant across the run.",
      "",
      strategy === "random"
        ? "Inputs are picked uniformly at random from the pool - two concurrent"
        : "Each concurrent submission takes the next contract in the pool, so no",
      strategy === "random"
        ? "transfers can select the same holding, and one loses."
        : "two in-flight submissions select the same holding.",
      "",
      "Everything else is identical to the transfer benchmark: explicit disclosure,",
      "sender submits alone, CIP-0056 TransferFactory_Transfer.",
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
        count: POOL,
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
              inputHoldingCids: [`$ref:holdings[${selector}]`],
              meta: { values: {} },
            },
            extraArgs: { context: { values: {} }, meta: { values: {} } },
          },
        },
        submit: { actAs: ["$p0"] },
      },
    ],
  };

  const file = path.join(outDir, `${strategy}.json`);
  fs.writeFileSync(file, JSON.stringify(workload, null, 2) + "\n", "utf8");
  console.log(`${path.basename(file)}  selector "${selector}", pool ${POOL}, ${OPS} ops`);
}
