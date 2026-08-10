import assert from "node:assert/strict";
import { test } from "node:test";
import { checkRegression, checkSla } from "../src/gate.ts";
import { summarize, type OpResult } from "../src/metrics.ts";

function summaryOf(o: {
  committed?: number;
  contention?: number;
  rejected?: number;
  latMs?: number;
  wallMs?: number;
}) {
  const { committed = 0, contention = 0, rejected = 0, latMs = 10, wallMs = 1000 } = o;
  const results: OpResult[] = [];
  const push = (n: number, outcome: OpResult["outcome"]) => {
    for (let i = 0; i < n; i++) results.push({ outcome, latencyMs: latMs });
  };
  push(committed, "committed");
  push(contention, "contention");
  push(rejected, "rejected");
  return summarize(results, wallMs);
}

test("checkSla passes when all thresholds are met", () => {
  const s = summaryOf({ committed: 100, latMs: 50, wallMs: 1000 }); // 100/s, p99 50, 0%
  assert.deepEqual(checkSla(s, { minThroughput: 50, maxP99Ms: 100, maxContentionPct: 5 }), {
    pass: true,
    failures: [],
  });
});

test("checkSla fails and reports each broken threshold", () => {
  const s = summaryOf({ committed: 30, contention: 70, latMs: 200, wallMs: 1000 }); // 30/s, p99 200, 70%
  const r = checkSla(s, { minThroughput: 50, maxP99Ms: 100, maxContentionPct: 10 });
  assert.equal(r.pass, false);
  assert.equal(r.failures.length, 3);
  assert.ok(r.failures.some((f) => /throughput/.test(f)));
  assert.ok(r.failures.some((f) => /p99/.test(f)));
  assert.ok(r.failures.some((f) => /contention/.test(f)));
});

test("checkRegression flags a throughput drop / p99 rise beyond tolerance", () => {
  const base = summaryOf({ committed: 100, latMs: 50, wallMs: 1000 }); // 100/s, p99 50
  const cur = summaryOf({ committed: 80, latMs: 65, wallMs: 1000 }); // 80/s (20% drop), p99 65 (30% rise)

  const drop = checkRegression(cur, base, { maxThroughputDropPct: 10 });
  assert.equal(drop.pass, false);
  assert.ok(drop.failures[0].includes("throughput"));

  const rise = checkRegression(cur, base, { maxP99RisePct: 20 });
  assert.equal(rise.pass, false);
  assert.ok(rise.failures[0].includes("p99"));

  // Loosen both tolerances → pass.
  assert.equal(
    checkRegression(cur, base, { maxThroughputDropPct: 25, maxP99RisePct: 40 }).pass,
    true,
  );
});
