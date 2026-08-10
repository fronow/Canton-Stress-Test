import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActiveContract, LedgerApi, SubmitResult, SubmitTreeResult } from "../src/ledger.ts";
import { runSweep } from "../src/sweep.ts";
import type { Workload } from "../src/workload.ts";

class FakeLedger implements LedgerApi {
  hints: string[] = [];
  async allocateParty(hint: string): Promise<string> {
    this.hints.push(hint);
    return `${hint}::fake`;
  }
  async activeContracts(): Promise<ActiveContract[]> {
    return [];
  }
  async submitAndWait(): Promise<SubmitResult> {
    return { ok: true, updateId: "u" };
  }
  async submitAndWaitForTree(): Promise<SubmitTreeResult> {
    return { ok: true, updateId: "u", created: [], exerciseResult: null };
  }
}

const workload: Workload = {
  parties: 2,
  setup: [],
  operations: [{ weight: 1, op: { kind: "create", template: "#p:M:T", args: {} } }],
};

test("runSweep runs each level and reports the swept dimension", async () => {
  const fake = new FakeLedger();
  const sweep = await runSweep(
    fake,
    workload,
    { kind: "closed", ops: 5, warmup: 0, concurrency: 0 },
    [2, 4, 8],
    { amount: "1.0", seed: 1, runId: "s" },
  );
  assert.equal(sweep.dimension, "concurrency");
  assert.deepEqual(sweep.points.map((p) => p.level), [2, 4, 8]);
  assert.ok(sweep.points.every((p) => p.report.summary.committed === 5));
  assert.ok(sweep.points.every((p) => p.report.model === "closed"));
  // fresh party hints per level (run isolation)
  assert.ok(fake.hints.some((h) => h.includes("-L2-")));
  assert.ok(fake.hints.some((h) => h.includes("-L8-")));
});

test("runSweep in open model sweeps the arrival rate", async () => {
  const fake = new FakeLedger();
  const sweep = await runSweep(
    fake,
    workload,
    { kind: "open", ops: 4, warmup: 0, rate: 0, maxInFlight: 8 },
    [10, 20],
    { amount: "1.0", seed: 1, runId: "s" },
  );
  assert.equal(sweep.dimension, "rate");
  assert.deepEqual(sweep.points.map((p) => p.level), [10, 20]);
  assert.ok(sweep.points.every((p) => p.report.model === "open"));
  assert.equal(sweep.points[0].report.targetRatePerSec, 10);
  assert.equal(sweep.points[1].report.targetRatePerSec, 20);
});
