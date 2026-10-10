// Reference cost table: what a synchronizer BILLS per transaction, by who pays.
//
// For each case: read the bill, run the workload's setup alone, read again,
// run setup + N measured operations, read a third time. Every run repeats the
// same setup, so
//
//   billed per op (per node) = (Δ measured run − Δ setup-only run) / committed
//
// Operations that lose a contention race fail at interpretation on the
// submitting participant and are never sequenced, so dividing by COMMITTED is
// right (checked on the cross-participant accept: 20 and 50 committed gave the
// same per-op bill to within 0.3%).
//
// Needs the metered network (../bootstrap-metered.canton) running with the
// registry DARs uploaded to both participants. See METERED.md.
// Usage: node examples/network/metered/measure-table.cjs [caseName ...]
// Env: JAVA, CANTON_JAR (as read.sh), OPS (default 10).

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const here = __dirname;
const repo = path.resolve(here, "../../..");
const results = path.join(here, "results");
fs.mkdirSync(results, { recursive: true });
const OPS = Number(process.env.OPS ?? 10);
const P1 = "http://localhost:7011";
const BOTH = "http://localhost:7011,http://localhost:7021";
const env = "examples/openzeppelin/envelope";

// std-spike parameters as `canton-stress <dar> --explain` generates them.
const std = (parties) => [
  "--set-json", `parties=${parties}`,
  "--set-json", "holdings=60",
  "--set", "instrumentId=StdToken",
  "--set", "transferAmount=1.0",
  "--set", "factoryTemplate=#std-spike:StdToken:StdTransferFactory",
  "--set-json", 'factoryArgs={"admin":"$role:admin","users":"$parties"}',
  "--set", "holdingTemplate=#std-spike:StdToken:StdHolding",
  "--set-json", 'holdingActAs=["$role:admin"]',
  "--set-json", 'holdingArgs={"issuer":"$role:admin","owner":"$p0","amount":"1000.0"}',
];

// The library transfer workload with parties spread over BOTH participants,
// so a growing stakeholder list lands on the other node and shows who pays.
const spread = path.join(results, "token-standard-transfer.spread.json");
const lib = JSON.parse(fs.readFileSync(path.join(repo, "workloads/token-standard-transfer.json"), "utf8"));
fs.writeFileSync(spread, JSON.stringify({ ...lib, placement: "round-robin" }, null, 2));

const cases = {
  "oz-propose": { file: `${env}/attrib-oz-xfer.json`, api: P1, args: [],
    what: "OpenZeppelin two-step transfer, step 1 (propose)" },
  "oz-accept": { file: `${env}/attrib-oz-accept.json`, api: P1, args: [],
    what: "OpenZeppelin two-step transfer, step 2 (accept)" },
  "oz-preapproved": { file: `${env}/attrib-oz-preapproved.json`, api: P1, args: [],
    what: "OpenZeppelin preapproved direct transfer" },
  "std-direct": { file: "workloads/token-standard-transfer.json", api: P1, args: std(6),
    what: "std-spike direct transfer, 6 parties" },
};
for (const n of [2, 4, 8, 16])
  cases[`std-spread-${n}`] = { file: spread, api: BOTH, args: std(n),
    what: `std-spike transfer, ${n} stakeholders over two participants` };

function bill() {
  const out = execFileSync("bash", [path.join(here, "read.sh"), "x"], { encoding: "utf8" });
  const m = {};
  for (const line of out.trim().split("\n")) {
    const [, member, bytes] = line.match(/x (\S+) consumed=(\d+)/) ?? [];
    if (member) m[member] = Number(bytes);
  }
  if (Object.keys(m).length === 0) throw new Error(`could not read the bill:\n${out}`);
  return m;
}
const delta = (a, b) => Object.fromEntries(Object.keys(b).map((k) => [k, b[k] - (a[k] ?? 0)]));

function run(name, c, extra) {
  const report = path.join(results, `table-${name}${extra.includes("--setup-only") ? "-setup" : ""}.json`);
  const args = ["src/cli.ts", "run", "--workload-file", c.file, "--api", c.api, "--model", "closed",
    "--concurrency", "1", "--warmup", "0", "--seed", "1", "--traffic-price", "60",
    "--report", report, ...c.args, ...extra];
  try {
    execFileSync("node", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    throw new Error(`${name} failed:\n${(e.stdout ?? "") + (e.stderr ?? "")}`.slice(0, 3000));
  }
  return fs.existsSync(report) ? JSON.parse(fs.readFileSync(report, "utf8")) : undefined;
}

const wanted = process.argv.slice(2);
for (const [name, c] of Object.entries(cases)) {
  if (wanted.length > 0 && !wanted.includes(name)) continue;
  const b0 = bill();
  run(name, c, ["--setup-only"]);
  const b1 = bill();
  const r = run(name, c, ["--ops", String(OPS)]);
  const b2 = bill();
  const setup = delta(b0, b1);
  const measured = delta(b1, b2);
  const committed = r.summary.committed;
  const perOp = Object.fromEntries(
    Object.keys(measured).map((k) => [k, Math.round((measured[k] - setup[k]) / committed)]),
  );
  const est = r.instrumentation?.traffic?.perOperation?.[0];
  const row = {
    case: name, what: c.what, committed, ops: r.summary.ops,
    billedPerOp: perOp,
    participantsTotal: Object.entries(perOp).filter(([k]) => k.startsWith("PAR")).reduce((s, [, v]) => s + v, 0),
    estimate: est ? { request: est.confirmationRequest, response: est.confirmationResponse, total: est.total } : null,
    preparedBytes: est?.preparedBytes ?? null,
    failed: r.instrumentation?.traffic?.failed ?? [],
  };
  fs.writeFileSync(path.join(results, `table-${name}.row.json`), JSON.stringify(row, null, 2));
  console.log(JSON.stringify(row));
}
