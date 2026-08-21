// Multi-input selection: what happens when one holding is NOT enough?
//
// Every measurement so far sent 1.0 out of 1000.0-value holdings, so a single
// input always covered the transfer and coin-combining never engaged. Real
// wallets fragment, and a fragmented wallet must gather several holdings per
// transfer.
//
// The prediction, if contention is a bookkeeping effect: gathering k inputs per
// transfer multiplies BOTH the consumption rate and the number of chances to
// land on something already spent, so contention should rise roughly with k.
// A transfer needing 4 inputs out of a pool of P should behave about like a
// single-input transfer out of a pool of P/4.
//
// Holdings are worth 10.0 each. Transfer size sets how many are needed:
//   1 input  -> amount 10.0
//   2 inputs -> amount 20.0
//   4 inputs -> amount 40.0
//   8 inputs -> amount 80.0
//
// The wallet offers the whole pool as candidate inputs and lets the registry
// take what it needs, which is what a naive wallet does.
//
//   node examples/openzeppelin/gen-multiinput.cjs

const fs = require("node:fs");
const path = require("node:path");

const OPS = 120;
const POOL = 1200;
const HOLDING_VALUE = 10.0;
const INPUTS = [1, 2, 4, 8];

const outDir = path.join(__dirname, "multiinput");
fs.mkdirSync(outDir, { recursive: true });

for (const k of INPUTS) {
  const amount = (HOLDING_VALUE * k).toFixed(1);
  // Offer k candidates so the registry has to gather exactly k of them.
  //
  // "[*!]" draws them WITHOUT replacement. Plain "[*]" draws each independently,
  // so one transfer could nominate the same holding twice — which fails for a
  // reason that is not contention, and gets likelier as k grows. That artifact
  // has the same shape as the effect being measured (contention rising with k),
  // so it has to be excluded by construction rather than argued away.
  const candidates = Array.from({ length: k }, () => "$ref:holdings[*!]");

  const workload = {
    _comment: [
      `Multi-input selection: ${k} input(s) per transfer.`,
      "",
      `Holdings are worth ${HOLDING_VALUE} each and the transfer is ${amount}, so the`,
      `registry must consume ${k} of them. The wallet nominates ${k} candidates picked`,
      "uniformly at random from its own pool - the naive strategy, extended to",
      "the multi-input case.",
      "",
      `Pool ${POOL}, ${OPS} transfers. If contention is a bookkeeping effect it should`,
      `rise roughly with the number of inputs, since each transfer both consumes`,
      "more of the pool and takes more chances of landing on something spent.",
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
            amount: HOLDING_VALUE.toFixed(1),
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
              amount,
              instrumentId: { admin: "$role:admin", id: "SIMPLE" },
              requestedAt: "$now-60s",
              executeBefore: "$now+1h",
              inputHoldingCids: candidates,
              meta: { values: {} },
            },
            extraArgs: { context: { values: {} }, meta: { values: {} } },
          },
        },
        submit: { actAs: ["$p0"] },
      },
    ],
  };

  const file = path.join(outDir, `inputs-${k}.json`);
  fs.writeFileSync(file, JSON.stringify(workload, null, 2) + "\n", "utf8");
  console.log(
    `${path.basename(file)}  ${k} input(s), amount ${amount}, pool ${POOL}, ${OPS} transfers`,
  );
}
