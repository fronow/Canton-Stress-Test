// Generate wallet-count scaling workloads for the OpenZeppelin token template.
//
// The question: does throughput scale with the number of independent sending
// wallets, or is ~15/s a property of the registry?
//
// Everything is held constant except the number of senders. Each sender owns
// its OWN holding pool and sends to its OWN receiver, so wallets never touch
// each other's holdings — the only thing that changes across runs is how many
// independent pools the same offered load is spread across.
//
//   node examples/openzeppelin/gen-scaling.js

const fs = require("node:fs");
const path = require("node:path");

// Pool sizing matters more than it looks. A FIXED pool per wallet is wrong:
// with one wallet doing every operation its pool drains hard (150 -> 30 in the
// first version of this sweep), while at eight wallets each pool barely moves.
// The 1-wallet arm is then handicapped by shrinking depth, and the measured
// contention gap is partly a pool-depth artefact rather than wallet count.
//
// So size each wallet's pool to 4x ITS OWN expected consumption: every arm
// drains by the same ~25%, and the total number of holdings created is constant
// across the sweep. Wallet count is then the only variable.
const OPS = 240;
const POOL_MULTIPLE = 4;
const WALLET_COUNTS = [1, 2, 4, 8];
const poolFor = (wallets) => Math.round((POOL_MULTIPLE * OPS) / wallets);

const outDir = path.join(__dirname, "scaling");
fs.mkdirSync(outDir, { recursive: true });

for (const w of WALLET_COUNTS) {
  const HOLDINGS_PER_WALLET = poolFor(w);
  const setup = [
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
  ];

  const operations = [];

  for (let k = 0; k < w; k++) {
    const sender = `$p${2 * k}`;
    const receiver = `$p${2 * k + 1}`;

    setup.push({
      id: `holdings${k}`,
      count: HOLDINGS_PER_WALLET,
      actAs: ["$role:admin", sender],
      op: {
        kind: "create",
        template: "#simple-token:SimpleToken.Holding:SimpleHolding",
        args: {
          admin: "$role:admin",
          owner: sender,
          instrumentId: { admin: "$role:admin", id: "SIMPLE" },
          amount: "1000.0",
          meta: { values: {} },
        },
      },
    });

    operations.push({
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
            sender,
            receiver,
            amount: "1.0",
            instrumentId: { admin: "$role:admin", id: "SIMPLE" },
            requestedAt: "$now-60s",
            executeBefore: "$now+1h",
            inputHoldingCids: [`$ref:holdings${k}[*]`],
            meta: { values: {} },
          },
          extraArgs: { context: { values: {} }, meta: { values: {} } },
        },
      },
      submit: { actAs: [sender] },
    });
  }

  const workload = {
    _comment: [
      `Wallet-count scaling: ${w} independent sending wallet(s).`,
      "",
      `Each of the ${w} senders owns its own pool of ${HOLDINGS_PER_WALLET} holdings and`,
      "sends to its own receiver, so senders never contend with each other - only",
      "with themselves. Input selection is a uniform random pick from the sender's",
      "own pool ($ref:holdingsK[*]), the same naive strategy as the single-wallet run.",
      "",
      "Explicit disclosure throughout: the sender submits alone and carries the",
      "factory's created-event blob, exactly as a wallet does.",
    ],
    version: 1,
    parties: Math.max(6, 2 * w),
    roles: ["admin"],
    setup,
    operations,
  };

  const file = path.join(outDir, `wallets-${w}.json`);
  fs.writeFileSync(file, JSON.stringify(workload, null, 2) + "\n", "utf8");
  console.log(
    `${path.basename(file)}  ${w} wallet(s), ${workload.parties} parties, ` +
      `${w * HOLDINGS_PER_WALLET} holdings, ${operations.length} operation(s)`,
  );
}
