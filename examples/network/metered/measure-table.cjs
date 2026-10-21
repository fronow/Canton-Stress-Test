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
// TAG keeps runs on different networks apart in results/ (e.g. TAG=n8 →
// table-amulet-dso-4-n8.json). Without it, a later run of the same case on a
// different network silently overwrites the earlier files.
const TAG = process.env.TAG ? `-${process.env.TAG}` : "";
const P1 = "http://localhost:7011";
const BOTH = "http://localhost:7011,http://localhost:7021";
// The first n participants of four-participants.conf.
// Participant i's JSON API is 7000 + 10*i + 1 (gen-network.cjs, four-participants.conf).
const NODES = (n) => Array.from({ length: n }, (_, k) => `http://localhost:${7000 + 10 * (k + 1) + 1}`).join(",");
const env = "examples/openzeppelin/envelope";

// std-spike parameters as `canton-stress <dar> --explain` generates them.
const std = (parties) => [
  "--set-json", `parties=${parties}`,
  "--set-json", `holdings=${process.env.HOLDINGS ?? 60}`,
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
// Same, but the registry admin (the signatory, so a CONFIRMING party) lives on
// the second participant instead of the submitter's.
const spreadAdmin = path.join(results, "token-standard-transfer.spread-admin2.json");
fs.writeFileSync(spreadAdmin, JSON.stringify({ ...lib, placement: "round-robin", rolePlacement: { admin: 1 } }, null, 2));

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

// Participant series (needs four-participants.conf). Series O: 8 parties
// spread over 1..4 participants; only the submitter's node confirms, the
// others host observers and the receiver. Series C: the admin, a signatory,
// moved to another node, which must then confirm.
cases["obs-1"] = { file: "workloads/token-standard-transfer.json", api: NODES(1), args: std(8),
  what: "8 parties on 1 participant" };
for (const k of [2, 3, 4])
  cases[`obs-${k}`] = { file: spread, api: NODES(k), args: std(8),
    what: `8 parties over ${k} participants, one confirming` };
// Role grid: the admin (signatory) and the receiver placed independently on
// participants 0..2, with the transfer's metadata empty or carrying 2,000
// characters. Separates WHICH node holds what, and whether a remote node's
// cost grows with the data it is sent. Population (sender) on node 0.
// Case name: g-a<admin node>-r<receiver node>-m<metadata chars>.
for (const [a, r] of [[0, 0], [0, 1], [1, 0], [1, 1], [1, 2]])
  for (const m of [0, 2000]) {
    const f = path.join(results, `grid-a${a}-r${r}-m${m}.json`);
    const g = JSON.parse(JSON.stringify(lib));
    g.roles = ["admin", "recv"];
    g.rolePlacement = { admin: a, recv: r };
    g.operations[0].op.args.transfer.receiver = "$role:recv";
    g.operations[0].op.args.transfer.meta = { values: m ? { note: "x".repeat(m) } : {} };
    fs.writeFileSync(f, JSON.stringify(g, null, 2));
    cases[`g-a${a}-r${r}-m${m}`] = { file: f, api: NODES(Math.max(a, r) + 1), args: std(2),
      what: `admin on node ${a}, receiver on node ${r}, metadata ${m} chars` };
  }

// Same grid with INCOMPRESSIBLE metadata. Repeated characters compress to
// almost nothing before the sequencer bills them (2,000 "x" added ~50 B), so a
// fixed pseudo-random hex string is used to test whether a remote node's cost
// grows with the data in the transaction. Deterministic, so runs repeat.
const noise = (n) => { let x = 12345, o = ""; while (o.length < n) { x = (x * 1103515245 + 12345) >>> 0; o += (x >>> 8).toString(16).padStart(6, "0"); } return o.slice(0, n); };
for (const [a, r] of [[0, 0], [0, 1]])
  for (const m of [2000, 4000]) {
    const f = path.join(results, `grid-a${a}-r${r}-rand${m}.json`);
    const g = JSON.parse(JSON.stringify(lib));
    g.roles = ["admin", "recv"];
    g.rolePlacement = { admin: a, recv: r };
    g.operations[0].op.args.transfer.receiver = "$role:recv";
    g.operations[0].op.args.transfer.meta = { values: { note: noise(m) } };
    fs.writeFileSync(f, JSON.stringify(g, null, 2));
    cases[`g-a${a}-r${r}-rand${m}`] = { file: f, api: NODES(Math.max(a, r) + 1), args: std(2),
      what: `admin on node ${a}, receiver on node ${r}, ${m} random hex chars of metadata` };
  }

// Pre-registered predictions (PREDICTIONS.md): held-out combinations.
const variant = (name, base, admin, recv, metaChars) => {
  const f = path.join(results, `pred-${name}.json`);
  const g = JSON.parse(JSON.stringify(base));
  g.roles = ["admin", "recv"];
  g.rolePlacement = { admin, recv };
  g.operations[0].op.args.transfer.receiver = "$role:recv";
  if (metaChars) g.operations[0].op.args.transfer.meta = { values: { note: noise(metaChars) } };
  fs.writeFileSync(f, JSON.stringify(g, null, 2));
  return f;
};
cases["P1"] = { file: variant("P1", lib, 1, 2, 2000), api: NODES(3), args: std(2), what: "P1: admin node 1, receiver node 2, 2,000 random chars" };
cases["P2"] = { file: variant("P2", lib, 1, 1, 4000), api: NODES(2), args: std(2), what: "P2: admin node 1, receiver node 1, 4,000 random chars" };
cases["P3"] = { file: variant("P3", lib, 0, 2, 0), api: NODES(3), args: std(2), what: "P3: admin node 0, receiver node 2, node 1 empty" };
if (process.env.DSO && fs.existsSync(path.join(here, "amulet", "amulet-transfer.json")))
  cases["P4"] = { file: variant("P4", JSON.parse(fs.readFileSync(path.join(here, "amulet", "amulet-transfer.json"), "utf8")), 0, 3, 0),
    api: NODES(4), args: ["--role-party", `admin=${process.env.DSO}`], what: "P4: Amulet, DSO on nodes 0-2, receiver node 3" };
if (process.env.DSO && fs.existsSync(path.join(here, "amulet", "amulet-transfer.json")))
  cases["P5"] = { file: variant("P5", JSON.parse(fs.readFileSync(path.join(here, "amulet", "amulet-transfer.json"), "utf8")), 0, 3, 0),
    api: NODES(4), args: ["--role-party", `admin=${process.env.DSO}`], what: "P5: Amulet, DSO on nodes 0-1, receiver node 3" };

// Inputs per transfer: k input holdings per std-spike transfer (production
// p50 1, p90 3), everything on one participant so only k varies. "[*!]" draws
// without replacement within one transfer, so a transfer never names the same
// holding twice. Case name: in-<k>.
for (const k of [1, 2, 3, 4, 6, 8]) {
  const f = path.join(results, `inputs-${k}.json`);
  const g = JSON.parse(JSON.stringify(lib));
  g.operations[0].op.args.transfer.inputHoldingCids = Array(k).fill("$ref:holdings[*!]");
  fs.writeFileSync(f, JSON.stringify(g, null, 2));
  cases[`in-${k}`] = { file: f, api: NODES(1), args: std(2), what: `std-spike transfer with ${k} input holding(s)` };
}

// A one-off case defined by a driver script (cosign/run-cosign.sh):
// CASE_NAME, CASE_FILE, CASE_ARGS (JSON array of extra CLI args), CASE_NODES.
if (process.env.CASE_NAME && process.env.CASE_FILE)
  cases[process.env.CASE_NAME] = { file: process.env.CASE_FILE, api: NODES(Number(process.env.CASE_NODES ?? 1)),
    args: JSON.parse(process.env.CASE_ARGS ?? "[]"), what: process.env.CASE_WHAT ?? process.env.CASE_NAME };

// Canton Coin (Amulet), generated by amulet/gen-amulet.cjs. The workload is
// self-contained (no --set), so no extra args.
const amulet = path.join(here, "amulet", "amulet-transfer.json");
cases["amulet-1"] = { file: amulet, api: NODES(1), args: [],
  what: "Canton Coin (Amulet) transfer, 1 participant" };
const amuletSpread = path.join(results, "amulet-transfer.spread.json");
if (fs.existsSync(amulet))
  fs.writeFileSync(amuletSpread, JSON.stringify({ ...JSON.parse(fs.readFileSync(amulet, "utf8")), placement: "round-robin" }, null, 2));
// Amulet with the DSO hosted on several participants (run-dso-series.sh sets
// DSO to the party id and DSO_K to how many nodes host it).
// AMULET_FILE swaps in another Amulet workload (e.g. amulet/amulet-preapproved.json);
// AMULET_CASE names it in the case id (default "amulet").
if (process.env.DSO)
  cases[`${process.env.AMULET_CASE ?? "amulet"}-dso-${process.env.DSO_K}`] = { file: process.env.AMULET_FILE ? path.resolve(process.env.AMULET_FILE) : amulet,
    api: NODES(1), args: ["--role-party", `admin=${process.env.DSO}`],
    what: `Canton Coin (Amulet) ${({ "amulet-pre": "transfer through a preapproval", "amulet-accept": "two-step transfer, accept (second step)" })[process.env.AMULET_CASE] ?? "transfer offer (two-step, first step)"}, DSO hosted on ${process.env.DSO_K} participant(s)` };
cases["amulet-2"] = { file: amuletSpread, api: NODES(2), args: [],
  what: "Canton Coin (Amulet) transfer, receiver on a 2nd participant" };

for (const k of [2, 4])
  cases[`conf-${k}`] = { file: spreadAdmin, api: NODES(k), args: std(8),
    what: `8 parties over ${k} participants, admin confirming on another node` };

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
  const report = path.join(results, `table-${name}${TAG}${extra.includes("--setup-only") ? "-setup" : ""}.json`);
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
  fs.writeFileSync(path.join(results, `table-${name}${TAG}.row.json`), JSON.stringify({ ...row, tag: process.env.TAG ?? null }, null, 2));
  console.log(JSON.stringify(row));
}
