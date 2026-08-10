import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assignEndpoints,
  mergeResults,
  runWorkers,
  runWorkersVia,
  splitEvenly,
  splitModel,
  type WorkerResult,
} from "../src/cluster.ts";
import { LatencyHistogram } from "../src/histogram.ts";
import type { LedgerApi } from "../src/ledger.ts";
import { runMeasured, type LoadModel } from "../src/load.ts";
import { percentile, summarize, type OpResult, type Outcome } from "../src/metrics.ts";
import type { Workload } from "../src/workload.ts";
import { startMockLedger } from "./fixtures/mock-ledger.ts";

const workload: Workload = {
  parties: 4,
  setup: [],
  operations: [{ weight: 1, op: { kind: "create", template: "pkg:M:T", args: {} } }],
};

const res = (outcome: Outcome, latencyMs: number, contractId?: string): OpResult => ({
  outcome,
  latencyMs,
  attribution: { template: "pkg:M:T", contractId, parties: ["alice"] },
});

function part(o: {
  i: number;
  api?: string;
  results: OpResult[];
  start: number;
  end: number;
  error?: string;
}): WorkerResult {
  return {
    workerIndex: o.i,
    api: o.api ?? "http://a",
    results: o.results,
    lagSamples: [],
    trafficEstimates: [],
    startedAtEpochMs: o.start,
    endedAtEpochMs: o.end,
    error: o.error,
  };
}

const closed: LoadModel = { kind: "closed", ops: 100, warmup: 0, concurrency: 16 };

test("splitEvenly distributes the remainder and always sums to the total", () => {
  assert.deepEqual(splitEvenly(10, 4), [3, 3, 2, 2]);
  assert.deepEqual(splitEvenly(3, 4), [1, 1, 1, 0]);
  assert.deepEqual(splitEvenly(100, 3).reduce((a, b) => a + b, 0), 100);
  assert.throws(() => splitEvenly(10, 0), /at least one worker/);
});

test("splitModel divides the AGGREGATE load, so the parts add up to what was asked", () => {
  const open: LoadModel = { kind: "open", ops: 90, warmup: 9, rate: 30, maxInFlight: 64 };
  const shares = splitModel(open, 3);
  assert.equal(shares.reduce((s, m) => s + m.ops, 0), 90);
  assert.equal(shares.reduce((s, m) => s + (m.rate ?? 0), 0), 30); // aggregate rate preserved
  assert.deepEqual(shares.map((m) => m.rate), [10, 10, 10]);
  assert.deepEqual(shares.map((m) => m.maxInFlight), [22, 22, 22]);

  const cShares = splitModel(closed, 3);
  assert.equal(cShares.reduce((s, m) => s + (m.concurrency ?? 0), 0), 16);
  // A worker must never end up with zero concurrency — it would never run.
  assert.ok(splitModel({ kind: "closed", ops: 10, warmup: 0, concurrency: 2 }, 4).every((m) => (m.concurrency ?? 0) >= 1));
});

test("assignEndpoints spreads workers round-robin over participants", () => {
  assert.deepEqual(assignEndpoints(["a", "b"], 5), ["a", "b", "a", "b", "a"]);
  assert.deepEqual(assignEndpoints(["a"], 3), ["a", "a", "a"]);
  assert.throws(() => assignEndpoints([], 2), /at least one endpoint/);
});

test("MERGED PERCENTILES ARE RECOMPUTED OVER POOLED SAMPLES, NOT AVERAGED", () => {
  // Two workers with deliberately different latency populations: one fast,
  // one slow. Averaging their p99s would be wrong in both directions.
  const fast = Array.from({ length: 100 }, (_, i) => res("committed", i + 1)); // 1..100
  const slow = Array.from({ length: 100 }, (_, i) => res("committed", 1000 + i)); // 1000..1099
  const merged = mergeResults(
    [
      part({ i: 0, results: fast, start: 1_000, end: 3_000 }),
      part({ i: 1, results: slow, start: 1_000, end: 3_000 }),
    ],
    closed,
    workload,
  );

  const pooled = [...fast, ...slow].map((r) => r.latencyMs).sort((a, b) => a - b);
  const truth = percentile(pooled, 99);
  assert.equal(merged.summary.latency.p99, truth);

  // And it is emphatically NOT the mean of the workers' p99s.
  const p99Fast = percentile(fast.map((r) => r.latencyMs).sort((a, b) => a - b), 99);
  const p99Slow = percentile(slow.map((r) => r.latencyMs).sort((a, b) => a - b), 99);
  assert.notEqual(merged.summary.latency.p99, (p99Fast + p99Slow) / 2);
  // The pooled p50 sits inside the fast population, which averaging would miss.
  assert.equal(merged.summary.latency.p50, percentile(pooled, 50));
  assert.equal(merged.summary.ops, 200);
});

test("throughput uses the UNION window — not a sum, not one worker's window", () => {
  // Two workers, each 100 committed ops. Worker 1 starts 500ms late and ends
  // 500ms later, so the real window is 3000ms, not 2500 and not 5500.
  const a = Array.from({ length: 100 }, () => res("committed", 10));
  const b = Array.from({ length: 100 }, () => res("committed", 10));
  const merged = mergeResults(
    [
      part({ i: 0, results: a, start: 10_000, end: 12_500 }),
      part({ i: 1, results: b, start: 10_500, end: 13_000 }),
    ],
    closed,
    workload,
  );
  assert.equal(merged.cluster.wallMs, 3_000);
  assert.equal(merged.cluster.startSkewMs, 500);
  // 200 committed over 3s.
  assert.equal(Math.round(merged.summary.throughputPerSec), 67);
  // Summing the windows (5.5s) or taking one (2.5s) would both be wrong.
  assert.notEqual(Math.round(merged.summary.throughputPerSec), Math.round(200 / 5.5));
  assert.notEqual(Math.round(merged.summary.throughputPerSec), Math.round(200 / 2.5));
});

test("a failed worker is reported but does not poison the pooled numbers", () => {
  const good = Array.from({ length: 10 }, () => res("committed", 20));
  const merged = mergeResults(
    [
      part({ i: 0, results: good, start: 1_000, end: 2_000 }),
      part({ i: 1, results: [], start: 0, end: 0, error: "connection refused" }),
    ],
    closed,
    workload,
  );
  // The dead worker's zero-epoch timestamps must not become the window.
  assert.equal(merged.cluster.wallMs, 1_000);
  assert.equal(merged.summary.ops, 10);
  assert.equal(merged.cluster.workers, 2);
  assert.equal(merged.cluster.perWorker[1].error, "connection refused");
});

test("instrumentation is re-derived over pooled samples, so a hotspot spanning workers is found", () => {
  // Each worker alone sees only 3 losses on the shared registry — unremarkable.
  // Pooled, that contract carries 6 of the 8 total contentions.
  const w = (extra: string) => [
    ...Array.from({ length: 3 }, () => res("contention", 50, "registry")),
    res("contention", 50, extra),
    ...Array.from({ length: 10 }, () => res("committed", 10, "other")),
  ];
  const merged = mergeResults(
    [
      part({ i: 0, results: w("x1"), start: 1_000, end: 2_000 }),
      part({ i: 1, results: w("x2"), start: 1_000, end: 2_000 }),
    ],
    closed,
    workload,
  );
  const hot = merged.instrumentation!.hotspots[0];
  assert.equal(hot.key, "registry");
  assert.equal(hot.contention, 6);
  assert.equal(merged.instrumentation!.contentionConcentration, 0.75);
});

test("per-endpoint totals split the run across participants", () => {
  const merged = mergeResults(
    [
      part({ i: 0, api: "http://p1", results: Array.from({ length: 6 }, () => res("committed", 10)), start: 0, end: 1_000 }),
      part({ i: 1, api: "http://p2", results: Array.from({ length: 4 }, () => res("committed", 10)), start: 0, end: 1_000 }),
    ],
    closed,
    workload,
  );
  assert.deepEqual(merged.cluster.endpoints, ["http://p1", "http://p2"]);
  assert.deepEqual(merged.cluster.perEndpoint.map((e) => e.committed), [6, 4]);
  assert.equal(merged.summary.committed, 10);
});

test("the start barrier opens AFTER preparation, not before it", async () => {
  // Why this matters: if a worker signals ready on receiving its job, then
  // "go" kicks off a variable amount of ACS-snapshotting per worker. Measured
  // against a live sandbox that was a full second of start skew across a 2.4s
  // window — the workers were not measuring the same interval. Sending ready
  // only once preparation is done took the skew to ~1ms.
  const trace: string[] = [];
  const fake: LedgerApi = {
    async allocateParty(hint) {
      return `${hint}::fake`;
    },
    async activeContracts() {
      trace.push("snapshot");
      return [];
    },
    async submitAndWait() {
      trace.push("submit");
      return { ok: true, updateId: "u" };
    },
    async submitAndWaitForTree() {
      return { ok: true, updateId: "u", created: [], exerciseResult: null };
    },
  };
  const exercising: Workload = {
    parties: 2,
    setup: [],
    operations: [{ weight: 1, op: { kind: "exercise", template: "pkg:M:T", choice: "Go" } }],
  };
  await runMeasured(
    fake,
    exercising,
    { kind: "closed", ops: 2, warmup: 0, concurrency: 1 },
    { parties: ["p0", "p1"], roles: {}, bindings: {} },
    {
      amount: "1.0",
      seed: 1,
      runId: "t",
      beforeStart: async () => {
        trace.push("BARRIER");
      },
    },
  );
  // The snapshot is taken before the barrier; nothing is submitted before it.
  assert.equal(trace[0], "snapshot");
  assert.equal(trace[1], "BARRIER");
  assert.ok(!trace.slice(0, 2).includes("submit"));
});

test("forked workers really run and their samples pool (end to end over IPC)", async () => {
  const mock = await startMockLedger(0);
  try {
    const workload: Workload = {
      parties: 3,
      setup: [],
      operations: [{ weight: 1, op: { kind: "create", template: "mock:M:T", args: {} } }],
    };
    const model: LoadModel = { kind: "closed", ops: 40, warmup: 0, concurrency: 8 };
    const shares = splitModel(model, 2);
    const jobs = shares.map((m, i) => ({
      workerIndex: i,
      api: mock.url,
      workload,
      model: m,
      state: { parties: ["p0::m", "p1::m", "p2::m"], roles: {}, bindings: {} },
      runId: `t-w${i}`,
      seed: 7,
      amount: "1.0",
      noTraffic: true,
    }));
    const parts = await runWorkers(jobs, { timeoutMs: 60_000 });

    assert.equal(parts.length, 2);
    for (const p of parts) assert.equal(p.error, undefined, `worker ${p.workerIndex}: ${p.error}`);
    const merged = mergeResults(parts, model, workload);
    assert.equal(merged.summary.ops, 40); // every share accounted for
    assert.equal(merged.summary.committed, 40);
    assert.equal(merged.cluster.workers, 2);
    // Command ids must be unique per worker or the participant would treat
    // the second worker's traffic as duplicate submissions.
    assert.equal(mock.counts.get("/v2/commands/submit-and-wait"), 40);
  } finally {
    await mock.close();
  }
});

test("workers run as a COMMAND over stdio, so they need not be on this machine", async () => {
  // The transport that makes remote workers possible: the coordinator spawns a
  // command and speaks line-delimited JSON over its pipes. Exactly the same
  // path an `ssh host canton-stress worker` invocation takes — the command is
  // local here only because this box has no second host to reach.
  const mock = await startMockLedger(0);
  try {
    const workload: Workload = {
      parties: 3,
      setup: [],
      operations: [{ weight: 1, op: { kind: "create", template: "mock:M:T", args: {} } }],
    };
    const model: LoadModel = { kind: "closed", ops: 30, warmup: 0, concurrency: 6 };
    const shares = splitModel(model, 2);
    const jobs = shares.map((m, i) => ({
      workerIndex: i,
      api: mock.url,
      workload,
      model: m,
      state: { parties: ["p0::m", "p1::m", "p2::m"], roles: {}, bindings: {} },
      runId: `remote-w${i}`,
      seed: 3,
      amount: "1.0",
      noTraffic: true,
    }));

    const parts = await runWorkersVia(jobs, "node src/cli.ts worker", { timeoutMs: 120_000 });

    assert.equal(parts.length, 2);
    for (const p of parts) assert.equal(p.error, undefined, `worker ${p.workerIndex}: ${p.error}`);
    const merged = mergeResults(parts, model, workload);
    assert.equal(merged.summary.ops, 30);
    assert.equal(merged.summary.committed, 30);
    assert.equal(mock.counts.get("/v2/commands/submit-and-wait"), 30);
    // The barrier held across separate processes: both windows overlap.
    assert.ok(merged.cluster.startSkewMs < 10_000);
  } finally {
    await mock.close();
  }
});

test("a worker command that cannot start is reported, not thrown", async () => {
  const jobs = [
    {
      workerIndex: 0,
      api: "http://127.0.0.1:1",
      workload: { parties: 1, setup: [], operations: [{ weight: 1, op: { kind: "create" as const, template: "M:T", args: {} } }] },
      model: { kind: "closed" as const, ops: 1, warmup: 0, concurrency: 1 },
      state: { parties: ["p"], roles: {}, bindings: {} },
      runId: "x",
      seed: 1,
      amount: "1.0",
      noTraffic: true,
    },
  ];
  const [part] = await runWorkersVia(jobs, "definitely-not-a-real-command-xyz", { timeoutMs: 30_000 });
  assert.ok(part.error, "expected the failure to be reported as data");
  assert.equal(part.results.length, 0);
});

test("CAPPED samples still yield exact totals and correct percentiles", () => {
  // The institutional-scale path: a worker runs millions of operations,
  // returns a bounded sample for attribution, and describes the full
  // distribution with a histogram. Throughput must come from the exact
  // counts, and percentiles from the merged histogram — never from however
  // many samples happened to be retained.
  const shard = (offset: number, n: number) => {
    const lat = Array.from({ length: n }, (_, i) => 10 + ((i + offset) % 500));
    const hist = LatencyHistogram.from(lat);
    return {
      workerIndex: offset,
      api: "http://a",
      // Only 50 samples survive, out of n.
      results: lat.slice(0, 50).map((ms) => res("committed", ms)),
      counts: { ops: n, committed: n - 10, contention: 8, rejected: 2 },
      histogram: hist.toJSON(),
      lagSamples: [],
      trafficEstimates: [],
      startedAtEpochMs: 1_000,
      endedAtEpochMs: 3_000,
    };
  };
  const parts = [shard(0, 100_000), shard(1, 100_000)];
  const merged = mergeResults(parts, closed, workload);

  // Totals come from the counts, not from the 100 retained samples.
  assert.equal(merged.summary.ops, 200_000);
  assert.equal(merged.summary.committed, 199_980);
  assert.equal(merged.summary.contention, 16);
  assert.equal(Math.round(merged.summary.throughputPerSec), Math.round(199_980 / 2));

  // Percentiles come from the merged histogram, so they describe all 200k
  // operations — the capped sample only covers 10..59ms.
  const truth = new LatencyHistogram();
  truth.merge(LatencyHistogram.fromJSON(parts[0].histogram!));
  truth.merge(LatencyHistogram.fromJSON(parts[1].histogram!));
  assert.equal(merged.summary.latency.p99, truth.percentile(99));
  assert.ok(merged.summary.latency.p99 > 400, "p99 must reflect the full range, not the retained slice");
  assert.equal(merged.summary.latency.max, truth.maxMs);
});

test("merging one worker matches a plain single-process summary", () => {
  // The distributed path must not change the numbers when there is nothing to
  // distribute — otherwise every comparison across worker counts is suspect.
  const results = Array.from({ length: 50 }, (_, i) => res(i < 40 ? "committed" : "contention", i * 3));
  const merged = mergeResults([part({ i: 0, results, start: 5_000, end: 7_000 })], closed, workload);
  const direct = summarize(results, 2_000);
  assert.deepEqual(merged.summary, direct);
});
