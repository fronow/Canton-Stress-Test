import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCommand, pickOp, type BuildCtx, type WeightedOp } from "../src/workload.ts";

const ops: WeightedOp[] = [
  { weight: 7, op: { kind: "create", template: "M:A", args: {} } },
  { weight: 2, op: { kind: "exercise", template: "M:A", choice: "Go" } },
  { weight: 1, op: { kind: "create", template: "M:B", args: {} } },
];

test("pickOp selects by weight across the [0,1) range", () => {
  // weights 7/2/1 over total 10 → boundaries at 0.7 and 0.9.
  assert.equal(pickOp(ops, 0.0).op.template, "M:A");
  assert.equal(pickOp(ops, 0.69).op.kind, "create");
  assert.equal(pickOp(ops, 0.7).op.kind, "exercise");
  assert.equal(pickOp(ops, 0.89).op.kind, "exercise");
  assert.equal(pickOp(ops, 0.9).op.template, "M:B");
  assert.equal(pickOp(ops, 0.999).op.template, "M:B");
});

test("pickOp is roughly proportional over many draws", () => {
  const counts: Record<string, number> = { "M:A-create": 0, "M:A-exercise": 0, "M:B-create": 0 };
  const N = 10000;
  for (let i = 0; i < N; i++) {
    const { op } = pickOp(ops, (i + 0.5) / N);
    counts[`${op.template}-${op.kind}`]++;
  }
  assert.ok(Math.abs(counts["M:A-create"] / N - 0.7) < 0.02);
  assert.ok(Math.abs(counts["M:A-exercise"] / N - 0.2) < 0.02);
  assert.ok(Math.abs(counts["M:B-create"] / N - 0.1) < 0.02);
});

test("pickOp rejects empty / zero-weight mixes", () => {
  assert.throws(() => pickOp([], 0.5), /no operations/);
  assert.throws(() => pickOp([{ weight: 0, op: ops[0].op }], 0.5), /sum to > 0/);
});

const contract = (contractId: string, payload: Record<string, unknown> = {}) => ({
  contractId,
  templateId: "M:A",
  payload,
});

const ctx: BuildCtx = {
  issuer: "I",
  party: () => "R",
  parties: ["P0", "P1"],
  amount: "100.0",
  rand: () => 0,
  contractsFor: (t) => (t === "M:A" ? [contract("c1", { owner: "OWN" }), contract("c2")] : []),
};

test("buildCommand: create resolves the payload", () => {
  const built = buildCommand({ kind: "create", template: "M:A", args: { issuer: "$issuer", owner: "$party" } }, ctx);
  assert.deepEqual(built?.command, {
    CreateCommand: { templateId: "M:A", createArguments: { issuer: "I", owner: "R" } },
  });
});

test("buildCommand: exercise picks a live target contract", () => {
  const built = buildCommand({ kind: "exercise", template: "M:A", choice: "Go", args: { to: "$party" } }, ctx);
  assert.ok(built && "ExerciseCommand" in built.command);
  const cmd = built.command as Extract<typeof built.command, { ExerciseCommand: unknown }>;
  assert.equal(cmd.ExerciseCommand.contractId, "c1"); // rand()=0 → first
  assert.deepEqual(cmd.ExerciseCommand.choiceArgument, { to: "R" });
});

test("buildCommand: exercise with no live target returns null (caller skips)", () => {
  const cmd = buildCommand({ kind: "exercise", template: "M:B", choice: "Go" }, ctx);
  assert.equal(cmd, null);
});

test("buildCommand: exercise args can read the target's own payload", () => {
  const built = buildCommand(
    { kind: "exercise", template: "M:A", choice: "Go", args: { keepOwner: "$target:owner" } },
    ctx,
  );
  assert.ok(built && "ExerciseCommand" in built.command);
  const cmd = built.command as Extract<typeof built.command, { ExerciseCommand: unknown }>;
  assert.deepEqual(cmd.ExerciseCommand.choiceArgument, { keepOwner: "OWN" });
  assert.equal(built.target?.contractId, "c1");
});

// ---------------------------------------------------------------------------
// "[*!]" — random input selection WITHOUT replacement inside one command.
//
// A multi-input transfer nominates several holdings at once. With plain "[*]"
// each nomination is drawn independently, so one command can name the same
// holding twice: a self-duplicate that fails for reasons that have nothing to
// do with contention, and whose likelihood grows with the number of inputs.
// That is precisely the shape of the effect a multi-input sweep measures, so
// the artifact would be indistinguishable from the finding.

/** A pool binding of `n` synthetic contract ids. */
const poolOf = (n: number) => ({ h: Array.from({ length: n }, (_, i) => `h${i}`) });

/** Deterministic cycling rand, so a draw-with-replacement collision is certain
 * rather than merely likely. */
const cyclingRand = (values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length];
};

const inputsCmd = (inputs: string[]) => ({
  kind: "exercise" as const,
  template: "M:Factory",
  contract: "$ref:h[0]",
  choice: "Transfer",
  args: { inputHoldingCids: inputs },
});

const argOf = (built: ReturnType<typeof buildCommand>) => {
  assert.ok(built && "ExerciseCommand" in built.command);
  const cmd = built.command as Extract<typeof built.command, { ExerciseCommand: unknown }>;
  return cmd.ExerciseCommand.choiceArgument as { inputHoldingCids: string[] };
};

test("[*] can nominate the same contract twice in one command — the confound", () => {
  const built = buildCommand(inputsCmd(["$ref:h[*]", "$ref:h[*]", "$ref:h[*]"]), {
    ...ctx,
    bindings: poolOf(10),
    // Every draw lands on the same index.
    rand: () => 0.35,
  });
  assert.deepEqual(argOf(built).inputHoldingCids, ["h3", "h3", "h3"]);
});

test("[*!] draws distinct contracts within one command", () => {
  const built = buildCommand(inputsCmd(["$ref:h[*!]", "$ref:h[*!]", "$ref:h[*!]"]), {
    ...ctx,
    bindings: poolOf(10),
    rand: () => 0.35,
  });
  const got = argOf(built).inputHoldingCids;
  assert.equal(new Set(got).size, 3, `expected 3 distinct, got ${got.join(",")}`);
  // Random start at index 3, then probing forward for unpicked entries.
  assert.deepEqual(got, ["h3", "h4", "h5"]);
});

test("[*!] still spreads across the pool — it is random, not sequential", () => {
  const built = buildCommand(inputsCmd(["$ref:h[*!]", "$ref:h[*!]", "$ref:h[*!]"]), {
    ...ctx,
    bindings: poolOf(100),
    rand: cyclingRand([0.9, 0.1, 0.5]),
  });
  assert.deepEqual(argOf(built).inputHoldingCids, ["h90", "h10", "h50"]);
});

test("[*!] is scoped to ONE command — the next command may reuse the same ids", () => {
  const shared: BuildCtx = { ...ctx, bindings: poolOf(10), rand: () => 0.35 };
  const a = argOf(buildCommand(inputsCmd(["$ref:h[*!]", "$ref:h[*!]"]), shared));
  const b = argOf(buildCommand(inputsCmd(["$ref:h[*!]", "$ref:h[*!]"]), shared));
  // Exclusion inside a submission models a wallet not naming one holding
  // twice; it must NOT model a pool that shrinks, or the run would stop
  // measuring double-spend contention altogether.
  assert.deepEqual(a.inputHoldingCids, ["h3", "h4"]);
  assert.deepEqual(b.inputHoldingCids, ["h3", "h4"]);
});

test("[*!] fails loudly when asked for more inputs than the pool holds", () => {
  assert.throws(
    () =>
      buildCommand(inputsCmd(["$ref:h[*!]", "$ref:h[*!]", "$ref:h[*!]"]), {
        ...ctx,
        bindings: poolOf(2),
        rand: () => 0,
      }),
    /more distinct contracts than the binding holds \(2\)/,
  );
});
