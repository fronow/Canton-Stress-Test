import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyOutcome,
  percentile,
  summarize,
  type OpResult,
} from "../src/metrics.ts";

test("percentile: nearest-rank over ascending data", () => {
  const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(xs, 50), 5);
  assert.equal(percentile(xs, 90), 9);
  assert.equal(percentile(xs, 100), 10);
  assert.equal(percentile([], 50), 0);
});

test("classifyOutcome: committed / contention / rejected", () => {
  assert.equal(classifyOutcome({ ok: true }), "committed");
  assert.equal(
    classifyOutcome({ ok: false, error: "LOCAL_VERDICT_LOCKED: contract is locked" }),
    "contention",
  );
  assert.equal(
    classifyOutcome({ ok: false, error: "CONTRACT_NOT_FOUND: #0:0 not found" }),
    "contention",
  );
  assert.equal(
    classifyOutcome({ ok: false, error: "DAML_AUTHORIZATION_ERROR: requires authorizers" }),
    "rejected",
  );
});

test("summarize: counts, throughput, contention rate, percentiles", () => {
  const results: OpResult[] = [
    { outcome: "committed", latencyMs: 10 },
    { outcome: "committed", latencyMs: 20 },
    { outcome: "committed", latencyMs: 30 },
    { outcome: "contention", latencyMs: 5 },
    { outcome: "rejected", latencyMs: 5 },
  ];
  const s = summarize(results, 1000); // 1 second wall clock
  assert.equal(s.ops, 5);
  assert.equal(s.committed, 3);
  assert.equal(s.contention, 1);
  assert.equal(s.rejected, 1);
  assert.equal(s.throughputPerSec, 3); // 3 committed in 1s
  assert.equal(s.attemptedPerSec, 5);
  assert.equal(s.contentionRate, 0.2);
  assert.equal(s.latency.max, 30);
  assert.ok(s.latency.p50 > 0);
});
