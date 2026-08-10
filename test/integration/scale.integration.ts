// SCALE integration tests — the behaviours that only appear at volume.
//
// These exist because two real bugs got through a hundred hermetic tests and
// were found only by running a million operations:
//
//   1. `process.send()` is asynchronous, and the worker exited immediately
//      after calling it. Small messages won that race; large ones did not.
//      A 1M-operation run reported 750,000 and marked workers "exited early
//      (code 0)" — a third of the run silently discarded.
//   2. Capping what a worker SENT did nothing about what it RETAINED, so
//      memory still grew with operation count.
//
// Neither is reachable at small N, which is exactly why they survived. These
// tests are slow by necessity and live outside the hermetic suite.
//
// Run:  CANTON_STRESS_IT=1 npm run test:integration
// No ledger needed — the mock is the target, because the point is the tool.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { mergeResults, runWorkers, splitModel, type WorkerJob } from "../../src/cluster.ts";
import type { LoadModel } from "../../src/load.ts";
import type { Workload } from "../../src/workload.ts";
import { startMockLedger, type MockLedger } from "../fixtures/mock-ledger.ts";

const ENABLED = process.env.CANTON_STRESS_IT === "1";

const workload: Workload = {
  parties: 3,
  setup: [],
  operations: [{ weight: 1, op: { kind: "create", template: "mock:M:T", args: {} } }],
};
const state = { parties: ["p0::m", "p1::m", "p2::m"], roles: {}, bindings: {} };

describe("at scale", { skip: !ENABLED && "set CANTON_STRESS_IT=1 to run" }, () => {
  let mock: MockLedger;

  before(async () => {
    mock = await startMockLedger(0);
  });
  after(async () => {
    await mock?.close();
  });

  const job = (i: number, model: LoadModel, maxSamples?: number): WorkerJob => ({
    workerIndex: i,
    api: mock.url,
    workload,
    model,
    state,
    runId: `scale-w${i}`,
    seed: 5 + i,
    amount: "1.0",
    noTraffic: true,
    maxSamples,
  });

  test("no worker is silently lost, and every operation is accounted for", async () => {
    // The failure this guards: a 1M-operation run once reported 750,000, with
    // workers marked "exited early (code 0)" — `process.send()` is
    // asynchronous and the worker exited before the message flushed. Two
    // things fixed it, and the ORDER matters: exiting inside the send callback
    // (correct, but defence in depth), and capping retention so the message is
    // small in the first place (what actually removed the failure mode —
    // verified by reintroducing the exit race, which no longer reproduces at
    // the default cap).
    //
    // What must hold regardless: no worker vanishes, and the totals are exact.
    const model: LoadModel = { kind: "closed", ops: 120_000, warmup: 0, concurrency: 64 };
    const shares = splitModel(model, 2);
    const parts = await runWorkers(shares.map((m, i) => job(i, m)), { timeoutMs: 10 * 60_000 });

    for (const p of parts) assert.equal(p.error, undefined, `worker ${p.workerIndex}: ${p.error}`);
    assert.deepEqual(parts.map((p) => p.counts?.ops), [60_000, 60_000]);

    const merged = mergeResults(parts, model, workload);
    assert.equal(merged.summary.ops, 120_000, "every operation must be accounted for");
    assert.equal(merged.summary.committed, 120_000);
    // Samples are deliberately a bounded subset — the counts above are what
    // make the totals exact, not the retained sample.
    assert.ok(
      parts.every((p) => p.results.length < 60_000),
      "retention must be capped, or memory grows with the run",
    );
  });

  test("MEMORY IS BOUNDED: doubling the operations must not double the footprint", async () => {
    const run = async (ops: number): Promise<number> => {
      const model: LoadModel = { kind: "closed", ops, warmup: 0, concurrency: 64 };
      const shares = splitModel(model, 2);
      global.gc?.();
      const before = process.memoryUsage().heapUsed;
      const parts = await runWorkers(shares.map((m, i) => job(i, m)), { timeoutMs: 10 * 60_000 });
      const merged = mergeResults(parts, model, workload);
      assert.equal(merged.summary.ops, ops, "counts must stay exact regardless of retention");
      // Percentiles come from the merged histogram, which saw every operation.
      assert.ok(merged.summary.latency.p99 > 0);
      global.gc?.();
      return process.memoryUsage().heapUsed - before;
    };

    const small = await run(50_000);
    const large = await run(200_000);

    // Four times the operations must not cost four times the memory. Retention
    // is capped at 20k per worker, so the coordinator's growth is flat-ish;
    // allow generous headroom for GC timing rather than asserting a tight
    // number that would flake.
    assert.ok(
      large < small * 2 + 64 * 1024 * 1024,
      `4x the operations grew the heap from ${(small / 1e6).toFixed(1)}MB to ${(large / 1e6).toFixed(1)}MB — retention is not bounded`,
    );
  });

  test("capped retention does not distort the numbers it reports", async () => {
    const model: LoadModel = { kind: "closed", ops: 60_000, warmup: 0, concurrency: 64 };
    const shares = splitModel(model, 2);
    // 5k retained out of 30k per worker: heavily truncated on purpose.
    const parts = await runWorkers(shares.map((m, i) => job(i, m, 5_000)), { timeoutMs: 10 * 60_000 });
    const merged = mergeResults(parts, model, workload);

    assert.equal(merged.summary.ops, 60_000, "totals come from counters, not samples");
    assert.equal(merged.summary.committed, 60_000);
    assert.ok(parts.every((p) => p.results.length <= 5_000), "samples must actually be capped");
    // The distribution still describes all 60k operations.
    assert.ok(merged.summary.latency.p50 > 0 && merged.summary.latency.p99 >= merged.summary.latency.p50);
    assert.ok(merged.summary.latency.max >= merged.summary.latency.p99);
  });
});
