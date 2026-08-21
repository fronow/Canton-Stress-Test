// Does envelope size scale with INFORMEE COUNT?
//
// The working hypothesis, put to K2F Labs on the forum: a confirmation request
// carries encrypted views per informee, so envelope cost should be mostly a
// function of how many parties a design makes stakeholders, and only marginally
// of what the payload holds. If that is right, the single most expensive design
// decision a registry author makes is who is a stakeholder.
//
// This isolates it. `StdTransferFactory` has `users : [Party]` as its observer
// list, so creating one with N users produces a transaction with N+1 informees
// and an otherwise IDENTICAL shape. Nothing else varies.
//
// There are two possible outcomes and both are worth having:
//
//   Prepared size grows with N  -> informee count drives the envelope, and the
//                                  prepared transaction captures it, so the
//                                  tool can price a design decision.
//   Prepared size is FLAT       -> the per-informee cost is added at submission
//                                  and the prepared transaction does not see
//                                  it. That would make prepared bytes a lower
//                                  bound that misses the dominant term, which
//                                  is a caveat the envelope benchmark would
//                                  need stated loudly.
//
//   node examples/openzeppelin/envelope/gen-informee.cjs

const fs = require("node:fs");
const path = require("node:path");

const COUNTS = [1, 2, 4, 8, 16, 32];
const outDir = __dirname;

for (const n of COUNTS) {
  const workload = {
    _comment: [
      `Informee scaling: ${n} observer(s) on the created contract.`,
      "",
      "`users` is StdTransferFactory's observer list, so this contract has",
      `${n} observers plus the admin signatory = ${n + 1} informees. The`,
      "payload is otherwise identical at every N, so any change in prepared",
      "size is attributable to informee count alone.",
      "",
      "Measured via the pre-run prepare call, not the run itself — envelope",
      "size is a property of the transaction's shape, so a handful of ops is",
      "enough.",
    ],
    version: 1,
    // The population IS the observer list, so party count is the variable.
    parties: n,
    roles: ["admin"],
    setup: [],
    operations: [
      {
        weight: 1,
        op: {
          kind: "create",
          template: "#std-spike:StdToken:StdTransferFactory",
          args: { admin: "$role:admin", users: "$parties" },
        },
        submit: { actAs: ["$role:admin"] },
      },
    ],
  };

  const file = path.join(outDir, `informee-${n}.json`);
  fs.writeFileSync(file, JSON.stringify(workload, null, 2) + "\n", "utf8");
  console.log(`${path.basename(file)}  ${n} observer(s) -> ${n + 1} informees`);
}
