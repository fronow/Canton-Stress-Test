import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTransactionTree } from "../src/ledger.ts";
import type {
  ActiveContract,
  LedgerApi,
  SubmitRequest,
  SubmitResult,
  SubmitTreeResult,
} from "../src/ledger.ts";
import { runWorkload } from "../src/load.ts";
import { runSetup, selectBinding, SetupError } from "../src/setup.ts";
import {
  validateWorkload,
  type PayloadCtx,
  type SetupStep,
  type Workload,
} from "../src/workload.ts";

/** A ledger that mints a predictable contract id per submission and records
 * everything, so a setup program's chaining can be asserted exactly. */
class FakeLedger implements LedgerApi {
  submissions: SubmitRequest[] = [];
  /** contractId -> payload, for exercise targets in the measured phase. */
  contracts: ActiveContract[] = [];
  failAt?: number;

  async allocateParty(hint: string): Promise<string> {
    return `${hint}::fake`;
  }
  async activeContracts(): Promise<ActiveContract[]> {
    return this.contracts;
  }
  async submitAndWait(req: SubmitRequest): Promise<SubmitResult> {
    this.submissions.push(req);
    return { ok: true, updateId: `u${this.submissions.length}` };
  }
  async submitAndWaitForTree(req: SubmitRequest): Promise<SubmitTreeResult> {
    this.submissions.push(req);
    if (this.failAt === this.submissions.length)
      return { ok: false, error: "DAML_AUTHORIZATION_ERROR: missing authorization" };
    const cmd = req.commands[0];
    const templateId =
      "CreateCommand" in cmd ? cmd.CreateCommand.templateId : cmd.ExerciseCommand.templateId;
    const contractId = `c${this.submissions.length}`;
    return {
      ok: true,
      updateId: `u${this.submissions.length}`,
      created: [{ contractId, templateId }],
      exerciseResult: contractId,
    };
  }
}

const ctx = (): PayloadCtx => ({
  issuer: "P0",
  party: () => "P0",
  parties: ["P0", "P1", "P2"],
  amount: "100.0",
  roles: { custodian: "CUST", issuer: "ISS" },
});

const opts = { runId: "t", rand: () => 0, defaultActAs: ["P0"] };

const exercised = (r: SubmitRequest) =>
  (r.commands[0] as { ExerciseCommand: { contractId: string; choiceArgument: unknown } })
    .ExerciseCommand;

test("a setup step can exercise on a contract an earlier step created", async () => {
  const fake = new FakeLedger();
  const steps: SetupStep[] = [
    { id: "factory", actAs: ["$role:custodian"], op: { kind: "create", template: "M:Factory", args: {} } },
    {
      id: "account",
      actAs: ["$role:custodian"],
      op: { kind: "exercise", template: "M:Factory", contract: "$ref:factory", choice: "Open", args: {} },
    },
  ];
  const res = await runSetup(() => fake, steps, ctx(), opts);

  assert.deepEqual(res.bindings, { factory: ["c1"], account: ["c2"] });
  assert.equal(res.submitted, 2);
  // The second step targeted the FIRST step's contract — the whole point of S2.
  assert.equal(exercised(fake.submissions[1]).contractId, "c1");
  assert.deepEqual(fake.submissions[1].actAs, ["CUST"]);
});

test("count repeats a step, binding a pool; $i and $pi vary per repetition", async () => {
  const fake = new FakeLedger();
  const steps: SetupStep[] = [
    {
      id: "accounts",
      count: 3,
      op: { kind: "create", template: "M:Account", args: { owner: "$pi", label: "acct-$i" } },
    },
  ];
  const res = await runSetup(() => fake, steps, ctx(), opts);

  assert.deepEqual(res.bindings.accounts, ["c1", "c2", "c3"]);
  const args = fake.submissions.map(
    (s) => (s.commands[0] as { CreateCommand: { createArguments: Record<string, unknown> } }).CreateCommand.createArguments,
  );
  assert.deepEqual(args.map((a) => a.owner), ["P0", "P1", "P2"]);
  assert.deepEqual(args.map((a) => a.label), ["acct-0", "acct-1", "acct-2"]);
});

test("$ref:pool[$i] pairs a repeated step against an earlier pool", async () => {
  const fake = new FakeLedger();
  const steps: SetupStep[] = [
    { id: "accounts", count: 3, op: { kind: "create", template: "M:Account", args: {} } },
    {
      id: "holdings",
      count: 3,
      op: { kind: "exercise", template: "M:Account", contract: "$ref:accounts[$i]", choice: "Credit", args: {} },
    },
  ];
  await runSetup(() => fake, steps, ctx(), opts);

  const targets = fake.submissions.slice(3).map((s) => exercised(s).contractId);
  assert.deepEqual(targets, ["c1", "c2", "c3"]); // one credit per account, in order
});

test("parallel setup preserves ORDER, so $ref:pool[$i] still pairs correctly", async () => {
  // Setup is not measured, so repetitions run concurrently — but a later step
  // pairing "$ref:accounts[$i]" against this pool depends on position meaning
  // what it says. Results must be placed by index, never by completion order.
  const fake = new FakeLedger();
  const original = fake.submitAndWaitForTree.bind(fake);
  let n = 0;
  fake.submitAndWaitForTree = async (req) => {
    // Finish in deliberately scrambled order.
    const mine = n++;
    await new Promise((r) => setTimeout(r, mine % 2 === 0 ? 12 : 1));
    return original(req);
  };
  const steps: SetupStep[] = [
    { id: "accounts", count: 8, op: { kind: "create", template: "M:Account", args: { i: "$i" } } },
  ];
  const res = await runSetup(() => fake, steps, ctx(), { ...opts, concurrency: 4 });

  assert.equal(res.bindings.accounts.length, 8);
  // Command ids carry the repetition index, so each repetition can be checked
  // against the index it was supposed to be.
  for (let i = 0; i < 8; i++) {
    const sub = fake.submissions.find((s) => s.commandId === `cs-t-setup-0-${i}`)!;
    const args = (sub.commands[0] as { CreateCommand: { createArguments: { i: number } } }).CreateCommand.createArguments;
    assert.equal(args.i, i, `repetition ${i} must carry index ${i}`);
  }
  assert.equal(new Set(res.bindings.accounts).size, 8, "no binding may be duplicated or lost");
});

test("a step that references its OWN pool stays sequential", async () => {
  // "$ref:pool[$i]" against the pool being filled cannot be parallelised:
  // repetition i needs what repetition i-1 bound.
  const fake = new FakeLedger();
  let inFlight = 0;
  let peak = 0;
  const original = fake.submitAndWaitForTree.bind(fake);
  fake.submitAndWaitForTree = async (req) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 3));
    inFlight--;
    return original(req);
  };
  const steps: SetupStep[] = [
    { id: "chain", count: 4, op: { kind: "create", template: "M:A", args: {} } },
    {
      id: "linked",
      count: 4,
      op: { kind: "exercise", template: "M:A", contract: "$ref:linked[$i]", choice: "Go", args: {} },
    },
  ];
  // The second step self-references, so it must never overlap.
  await assert.rejects(() => runSetup(() => fake, steps, ctx(), { ...opts, concurrency: 4 }));
  // The first (independent) step did go wide.
  assert.ok(peak > 1, "an independent step should run concurrently");
});

test("a rejected setup command fails loudly, naming the step", async () => {
  const fake = new FakeLedger();
  fake.failAt = 2;
  const steps: SetupStep[] = [
    { id: "a", op: { kind: "create", template: "M:A", args: {} } },
    { id: "b", op: { kind: "create", template: "M:B", args: {} } },
  ];
  await assert.rejects(
    () => runSetup(() => fake, steps, ctx(), opts),
    (e: unknown) =>
      e instanceof SetupError && e.step === 1 && /setup step 2:.*AUTHORIZATION/.test(e.message),
  );
});

test("referencing an unbound id fails with a pointed message", async () => {
  const fake = new FakeLedger();
  const steps: SetupStep[] = [
    { op: { kind: "exercise", template: "M:A", contract: "$ref:nope", choice: "Go", args: {} } },
  ];
  await assert.rejects(
    () => runSetup(() => fake, steps, ctx(), opts),
    /no setup step binds the id "nope"/,
  );
});

test("a disclosed step captures its blob AS THE STEP'S OWN SUBMITTERS", async () => {
  // The bug this pins: the blob was read as the default submitter (party 0),
  // but a registry factory is `signatory admin` with no observers — so nobody
  // else can see it, and disclosure silently produced nothing.
  const fake = new FakeLedger();
  const readers: string[][] = [];
  (fake as LedgerApi).disclosureFor = async (contractId, readAs) => {
    readers.push(readAs);
    // Only the admin can see it.
    if (!readAs.includes("CUST")) return undefined;
    return { templateId: "M:Factory", contractId, createdEventBlob: "blob", synchronizerId: "sync" };
  };
  const steps: SetupStep[] = [
    {
      id: "factory",
      disclose: true,
      actAs: ["$role:custodian"],
      op: { kind: "create", template: "M:Factory", args: {} },
    },
  ];
  const res = await runSetup(() => fake, steps, ctx(), opts);

  assert.deepEqual(readers, [["CUST"]], "must read as the step's actAs, not the default submitter");
  assert.equal(res.disclosures.length, 1);
  assert.equal(res.disclosures[0].createdEventBlob, "blob");
});

test("a disclosed step that yields no blob fails loudly rather than silently", async () => {
  const fake = new FakeLedger();
  (fake as LedgerApi).disclosureFor = async () => undefined;
  const steps: SetupStep[] = [
    { id: "f", disclose: true, op: { kind: "create", template: "M:F", args: {} } },
  ];
  await assert.rejects(() => runSetup(() => fake, steps, ctx(), opts), /no created-event blob/);
});

test("selectBinding prefers the choice's own return value, then a bind filter", () => {
  const created = [
    { contractId: "x1", templateId: "pkg:M:Receipt" },
    { contractId: "x2", templateId: "pkg:M:Account" },
  ];
  // The choice says it produced x2 — trust that over node order.
  assert.equal(selectBinding(created, "x2", undefined), "x2");
  // An explicit filter wins.
  assert.equal(selectBinding(created, "x2", "Receipt"), "x1");
  // A non-contract-id result (e.g. a unit or record) falls back to node order.
  assert.equal(selectBinding(created, { some: "record" }, undefined), "x1");
  assert.equal(selectBinding([], null, undefined), null);
  assert.equal(selectBinding(created, null, "Missing"), null);
});

test("parseTransactionTree reads the shape a live sandbox returns", () => {
  // Captured verbatim from Canton 3.4.11 (daml sandbox, JSON API v2).
  const tree = {
    updateId: "1220ecf3",
    eventsById: {
      "1": { CreatedTreeEvent: { value: { contractId: "00aa1d", templateId: "198d4a:Settlement:Account" } } },
      "0": { ExercisedTreeEvent: { value: { exerciseResult: "00aa1d" } } },
    },
  };
  const r = parseTransactionTree(tree);
  assert.ok(r.ok);
  assert.deepEqual(r.created, [{ contractId: "00aa1d", templateId: "198d4a:Settlement:Account" }]);
  assert.equal(r.exerciseResult, "00aa1d");
  assert.equal(parseTransactionTree(undefined).ok, false);
});

test("measured ops submit as the target contract's own owner (actAsFrom)", async () => {
  const fake = new FakeLedger();
  fake.contracts = [{ contractId: "h1", templateId: "M:Holding", payload: { owner: "OWNER::fake" } }];
  const workload: Workload = {
    parties: 2,
    roles: ["custodian"],
    setup: [],
    operations: [
      {
        weight: 1,
        op: { kind: "exercise", template: "M:Holding", choice: "Transfer", actAsFrom: ["owner"], args: {} },
        submit: { actAs: ["$role:custodian"] },
      },
    ],
  };
  await runWorkload(fake, workload, { kind: "closed", ops: 2, warmup: 0, concurrency: 1 }, {
    amount: "1.0",
    seed: 1,
    runId: "t",
  });
  const op = fake.submissions.find((s) => s.commandId.includes("-op-"))!;
  // The holder authorizes; the custodian rides along for visibility.
  assert.deepEqual([...op.actAs].sort(), ["OWNER::fake", "cs-t-custodian::fake"]);
});

test("the pre-S2 setup form (a flat list of ops) still runs", async () => {
  const fake = new FakeLedger();
  const workload: Workload = {
    parties: 2,
    setup: [{ kind: "create", template: "M:T", args: { owner: "$party" } }],
    operations: [{ weight: 1, op: { kind: "create", template: "M:T", args: {} } }],
  };
  const rep = await runWorkload(fake, workload, { kind: "closed", ops: 3, warmup: 0, concurrency: 1 }, {
    amount: "1.0",
    seed: 1,
    runId: "t",
  });
  assert.equal(rep.summary.committed, 3);
  assert.equal(rep.setup?.submitted, 1);
});

test("validateWorkload catches the mistakes that would waste a sandbox boot", () => {
  const problems = validateWorkload({
    parties: 0,
    roles: ["custodian"],
    setup: [
      { id: "f", op: { kind: "create", template: "M:F", args: { p: "$role:nosuch" } } },
      // exercise with no `contract`, and a ref to an id bound only LATER
      { op: { kind: "exercise", template: "M:F", choice: "Go", args: { a: "$ref:later" } } },
      { id: "later", op: { kind: "create", template: "M:L", args: {} } },
    ],
    operations: [],
  });
  const joined = problems.join("\n");
  assert.match(joined, /parties must be a positive integer/);
  assert.match(joined, /\$role:nosuch/);
  assert.match(joined, /must name its target with "contract"/);
  assert.match(joined, /no setup step before it binds the id "later"/);
  assert.match(joined, /operations must be a non-empty array/);

  assert.deepEqual(
    validateWorkload({
      parties: 2,
      roles: ["custodian"],
      setup: [{ id: "f", actAs: ["$role:custodian"], op: { kind: "create", template: "M:F", args: {} } }],
      operations: [
        {
          weight: 1,
          op: { kind: "exercise", template: "M:F", choice: "Go", args: { to: "$ref:f" } },
        },
      ],
    }),
    [],
  );
});
