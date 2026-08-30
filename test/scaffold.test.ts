import assert from "node:assert/strict";
import { test } from "node:test";
import { scaffold, topoSort } from "../src/scaffold.ts";
import type { DarInfo, DarTemplate } from "../src/inspect.ts";

/** A template with just enough shape to exercise the scaffolder. */
const tpl = (
  name: string,
  o: Partial<DarTemplate> = {},
): DarTemplate => ({
  module: "M",
  name,
  interfaces: [],
  id: `#pkg:M:${name}`,
  fields: [],
  signatories: [],
  choices: [],
  dependsOn: [],
  ...o,
});

const info = (templates: DarTemplate[]): DarInfo => ({
  packageName: "pkg",
  packageVersion: "1.0",
  templates,
  dependencies: [],
});

const goChoice = { name: "Go", consuming: true, returnType: "()", fields: [], controllers: [] };

// ---------------------------------------------------------------------------
// Dependency ordering. This is the part that makes a generated setup program
// actually run: a template holding a `ContractId T` cannot be created before a
// T exists, and the DAR states that relationship in its field types.

test("topoSort puts dependencies before the templates that need them", () => {
  const order = topoSort([
    tpl("Holding", { dependsOn: ["Account"] }),
    tpl("Account", { dependsOn: ["Factory"] }),
    tpl("Factory"),
  ]);
  assert.ok(order.ok);
  assert.deepEqual(order.order, ["Factory", "Account", "Holding"]);
});

test("topoSort is stable, so a DAR always scaffolds to the same file", () => {
  const r = topoSort([tpl("A"), tpl("B"), tpl("C")]);
  assert.ok(r.ok);
  assert.deepEqual(r.order, ["A", "B", "C"]);
});

test("topoSort reports a cycle rather than breaking it arbitrarily", () => {
  // Dropping an edge would emit a workload that fails at run time for a reason
  // the author cannot see in the file.
  const r = topoSort([
    tpl("A", { dependsOn: ["B"] }),
    tpl("B", { dependsOn: ["A"] }),
  ]);
  assert.equal(r.ok, false);
  if (!r.ok) assert.deepEqual(r.cycle.sort(), ["A", "B"]);
});

// ---------------------------------------------------------------------------
// Value synthesis

test("a ContractId field references the setup step that creates it", () => {
  const r = scaffold(
    info([
      tpl("Account", { choices: [goChoice] }),
      tpl("Holding", {
        dependsOn: ["Account"],
        fields: [{ name: "account", type: "ContractId Account" }],
        choices: [goChoice],
      }),
    ]),
  );
  assert.ok(r.ok);
  const steps = r.scaffold.workload.setup as { id: string; op: { args: Record<string, unknown> } }[];
  const holding = steps.find((s) => s.id === "holding")!;
  assert.equal(holding.op.args.account, "$ref:account[$i]");
});

test("a receiving party is a DIFFERENT party from the owner", () => {
  // newOwner = owner would be a self-transfer, which measures a workflow that
  // never moves anything between parties.
  const r = scaffold(
    info([
      tpl("Token", {
        fields: [{ name: "owner", type: "Party" }],
        choices: [
          { ...goChoice, name: "Transfer", fields: [{ name: "newOwner", type: "Party" }] },
        ],
      }),
    ]),
  );
  assert.ok(r.ok);
  const op = (r.scaffold.workload.operations as { op: { args: Record<string, unknown> } }[])[0];
  assert.equal(op.op.args.newOwner, "$p1");
  const steps = r.scaffold.workload.setup as { op: { args: Record<string, unknown> } }[];
  assert.equal(steps[0].op.args.owner, "$p0");
});

test("an admin-ish party maps to the admin role", () => {
  const r = scaffold(info([tpl("T", { fields: [{ name: "issuer", type: "Party" }], choices: [goChoice] })]));
  assert.ok(r.ok);
  const steps = r.scaffold.workload.setup as { op: { args: Record<string, unknown> } }[];
  assert.equal(steps[0].op.args.issuer, "$role:admin");
});

test("an unknown record type becomes a TODO and is reported, not guessed", () => {
  const r = scaffold(
    info([tpl("T", { fields: [{ name: "cfg", type: "SettlementInfo" }], choices: [goChoice] })]),
  );
  assert.ok(r.ok);
  const steps = r.scaffold.workload.setup as { op: { args: Record<string, unknown> } }[];
  assert.equal(steps[0].op.args.cfg, "TODO:SettlementInfo");
  assert.ok(
    r.scaffold.notes.some((n) => n.where === "T.cfg" && /SettlementInfo/.test(n.what)),
    "the note must name the field and the type",
  );
});

// ---------------------------------------------------------------------------
// Choosing what to measure

test("prefers a consuming choice — a nonconsuming one cannot contend", () => {
  const r = scaffold(
    info([
      tpl("T", {
        choices: [
          { ...goChoice, name: "Peek", consuming: false },
          { ...goChoice, name: "Spend", consuming: true },
        ],
      }),
    ]),
  );
  assert.ok(r.ok);
  assert.equal(r.scaffold.measuring, "T:Spend");
});

test("falls back to a nonconsuming choice, and says what that costs", () => {
  const r = scaffold(info([tpl("T", { choices: [{ ...goChoice, name: "Peek", consuming: false }] })]));
  assert.ok(r.ok);
  assert.equal(r.scaffold.measuring, "T:Peek");
  assert.ok(
    r.scaffold.notes.some((n) => /nonconsuming/.test(n.what) && /contention/.test(n.what)),
    "must warn that a nonconsuming choice measures throughput but not contention",
  );
});

// ---------------------------------------------------------------------------
// Refusals

test("refuses a DAR with no templates", () => {
  const r = scaffold(info([]));
  assert.equal(r.ok, false);
});

test("refuses when nothing declares a choice, and points somewhere useful", () => {
  const r = scaffold(info([tpl("A"), tpl("B")]));
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.reasons.join(" ").includes("create-throughput"));
});

test("the generated workload has the shape the runner expects", () => {
  const r = scaffold(info([tpl("T", { choices: [goChoice] })]), { holdings: 42 });
  assert.ok(r.ok);
  const w = r.scaffold.workload as Record<string, unknown>;
  assert.equal(w.version, 1);
  assert.deepEqual(w.roles, ["admin"]);
  assert.equal((w.setup as unknown[]).length, 1);
  assert.equal((w.setup as { count: number }[])[0].count, 42);
  assert.equal((w.operations as unknown[]).length, 1);
});
