import assert from "node:assert/strict";
import { test } from "node:test";
import { analyseMode, defaultSpec, rateSchedule, type ModeSpec } from "../src/modes.ts";
import type { OpResult, Outcome } from "../src/metrics.ts";
import { rateAt, runOpen, type Clock } from "../src/schedule.ts";
import {
  bucketize,
  dominantFailure,
  findBreakingPoint,
  findCliff,
  findDrift,
  findKnee,
  findRecovery,
} from "../src/timeseries.ts";

/** Virtual clock — the same device S3 uses, so schedules are verified exactly
 * instead of being raced against wall time. */
function virtualClock(): Clock & { t: number } {
  const c = {
    t: 0,
    now: () => c.t,
    sleep: async (ms: number) => {
      c.t += Math.max(0, ms);
    },
  };
  return c;
}

const op = (outcome: Outcome, latencyMs: number, atMs: number, error?: string): OpResult => ({
  outcome,
  latencyMs,
  atMs,
  error,
});

// ---- the rate primitive ----------------------------------------------------

test("rate profiles have the shape each mode needs", () => {
  const ramp = rateSchedule({ mode: "ramp", durationMs: 1000, fromRate: 10, toRate: 110, bucketMs: 100, warmupMs: 0 });
  assert.equal(rateAt(ramp, 0), 10);
  assert.equal(rateAt(ramp, 500), 60); // linear midpoint
  assert.equal(rateAt(ramp, 1000), 110);
  assert.equal(rateAt(ramp, 99999), 110); // clamped past the end

  const soak = rateSchedule({ mode: "soak", durationMs: 1000, fromRate: 25, toRate: 25, bucketMs: 100, warmupMs: 0 });
  assert.equal(rateAt(soak, 0), 25);
  assert.equal(rateAt(soak, 900), 25);

  const spike = rateSchedule({
    mode: "spike", durationMs: 900, fromRate: 5, toRate: 50, spikeStartMs: 300, spikeMs: 200, bucketMs: 100, warmupMs: 0,
  });
  assert.equal(rateAt(spike, 299), 5);
  assert.equal(rateAt(spike, 300), 50); // burst starts
  assert.equal(rateAt(spike, 499), 50);
  assert.equal(rateAt(spike, 500), 5); // and ends
});

test("a ramping schedule really produces accelerating arrivals (virtual time)", async () => {
  const clock = virtualClock();
  const at: number[] = [];
  // 10/s climbing to 50/s over 2s: gaps should shrink from ~100ms to ~20ms.
  const r = await runOpen({
    durationMs: 2000,
    warmup: 0,
    ratePerSec: rateSchedule({ mode: "ramp", durationMs: 2000, fromRate: 10, toRate: 50, bucketMs: 100, warmupMs: 0 }),
    maxInFlight: 1000,
    clock,
    task: async () => {
      at.push(clock.t);
      return { ok: true };
    },
  });
  assert.ok(at.length > 20, `expected many arrivals, got ${at.length}`);
  const firstGap = at[1] - at[0];
  const lastGap = at[at.length - 1] - at[at.length - 2];
  assert.ok(Math.abs(firstGap - 100) < 5, `first gap ${firstGap} should be ~100ms (10/s)`);
  assert.ok(lastGap < firstGap / 3, `last gap ${lastGap} should be far smaller than ${firstGap}`);
  // Duration-bounded: nothing scheduled past the window.
  assert.ok(at[at.length - 1] < 2000);
  assert.equal(r.results.length, at.length);
});

test("duration-driven runs stop on time, and warmupMs discards the early window", async () => {
  const clock = virtualClock();
  const r = await runOpen({
    durationMs: 1000,
    warmup: { ms: 400 },
    ratePerSec: 10, // 100ms gaps → 10 arrivals, 4 of them in warmup
    maxInFlight: 100,
    clock,
    task: async () => ({ ok: true }),
  });
  assert.equal(r.dispatched, 10);
  assert.equal(r.results.length, 6); // 400..900ms
  assert.ok(r.results.every((x) => (x.atMs ?? 0) >= 400));
});

test("results carry their SCHEDULED position, so a backlog cannot reorder the timeline", async () => {
  const clock = virtualClock();
  const r = await runOpen({
    count: 5,
    warmup: 0,
    ratePerSec: 10,
    maxInFlight: 100,
    clock,
    // Every op takes 250ms — far longer than the 100ms gap, so they pile up.
    task: async () => {
      clock.t += 250;
      return { ok: true };
    },
  });
  // Timeline reflects the offered load (0,100,200,…), not completion order.
  assert.deepEqual(r.results.map((x) => x.atMs).sort((a, b) => a! - b!), [0, 100, 200, 300, 400]);
});

// ---- bucketing -------------------------------------------------------------

test("bucketize groups by scheduled time and computes per-bucket rates", () => {
  const results = [
    op("committed", 10, 0), op("committed", 12, 400), op("contention", 90, 900),
    op("committed", 20, 1000), op("committed", 22, 1500),
  ];
  const bs = bucketize(results, 1000);
  assert.equal(bs.length, 2);
  assert.equal(bs[0].ops, 3);
  assert.equal(bs[0].committed, 2);
  assert.equal(bs[0].throughputPerSec, 2); // 2 committed in a 1s bucket
  assert.equal(bs[0].offeredPerSec, 3);
  assert.equal(Math.round(bs[0].contentionRate * 100), 33);
  assert.equal(bs[1].ops, 2);
  assert.deepEqual(bucketize([], 1000), []);
});

// ---- the verdicts ----------------------------------------------------------

const many = (n: number, f: (i: number) => OpResult): OpResult[] =>
  Array.from({ length: n }, (_, i) => f(i));

test("findKnee reports where latency bends — and stays quiet on a flat run", () => {
  // 10 buckets: p99 flat at ~20ms for 5, then jumps to 300ms and stays.
  const results = many(200, (i) => {
    const t = Math.floor(i / 20) * 1000;
    return op("committed", i < 100 ? 20 : 300, t);
  });
  const knee = findKnee(bucketize(results, 1000))!;
  assert.ok(knee, "expected a knee");
  assert.equal(knee.atMs, 5000);
  assert.equal(knee.baselineP99, 20);
  assert.equal(knee.p99, 300);

  // A flat run must NOT produce a knee — inventing one would be worse than
  // reporting nothing.
  const flat = many(200, (i) => op("committed", 20, Math.floor(i / 20) * 1000));
  assert.equal(findKnee(bucketize(flat, 1000)), undefined);
  // Nor should a single outlier bucket.
  const blip = many(200, (i) => op("committed", i >= 100 && i < 120 ? 300 : 20, Math.floor(i / 20) * 1000));
  assert.equal(findKnee(bucketize(blip, 1000)), undefined);
});

test("findCliff reports where throughput stops growing, only if the run pushed past it", () => {
  // What a real cliff looks like: offered load keeps climbing throughout, but
  // committed throughput plateaus at 25/s and the excess turns into failures.
  const results: OpResult[] = [];
  const offered = [5, 10, 15, 20, 25, 32, 40, 48, 56, 64];
  offered.forEach((n, b) => {
    const committed = Math.min(25, n);
    for (let i = 0; i < n; i++)
      results.push(i < committed ? op("committed", 30, b * 1000) : op("contention", 400, b * 1000));
  });
  const cliff = findCliff(bucketize(results, 1000))!;
  assert.ok(cliff, "expected a cliff");
  assert.equal(cliff.peakThroughputPerSec, 25);
  assert.equal(cliff.atMs, 4000); // first bucket reaching the peak

  // A run still climbing at the end has not found a cliff.
  const climbing: OpResult[] = [];
  [5, 10, 15, 20, 25, 30, 35, 40].forEach((n, b) => {
    for (let i = 0; i < n; i++) climbing.push(op("committed", 30, b * 1000));
  });
  assert.equal(findCliff(bucketize(climbing, 1000)), undefined);

  // And a FLAT run has no cliff either: throughput that never grew because the
  // load never grew is not a capacity limit. Reporting one here would put a
  // bogus cliff in the very first bucket of every steady run.
  const flat: OpResult[] = [];
  for (let b = 0; b < 10; b++)
    for (let i = 0; i < 20; i++) flat.push(op("committed", 30, b * 1000));
  assert.equal(findCliff(bucketize(flat, 1000)), undefined);
});

test("findDrift catches a soak that degrades and passes one that holds", () => {
  // p99 doubles from the first quarter to the last.
  const degrading = many(400, (i) => {
    const b = Math.floor(i / 20);
    return op("committed", b < 5 ? 50 : 150, b * 1000);
  });
  const d = findDrift(bucketize(degrading, 1000))!;
  assert.ok(d.degraded);
  assert.equal(d.firstP99, 50);
  assert.equal(d.lastP99, 150);
  assert.equal(d.p99ChangePct, 200);

  const steady = many(400, (i) => op("committed", 50, Math.floor(i / 20) * 1000));
  const s = findDrift(bucketize(steady, 1000))!;
  assert.equal(s.degraded, false);
  assert.equal(s.p99ChangePct, 0);
});

test("findRecovery measures the return to baseline, and flags a system that never comes back", () => {
  // baseline 0-2s at 20ms, burst 3-4s at 500ms, then back to 20ms from 5s.
  const build = (tailMs: number) => {
    const rs: OpResult[] = [];
    for (let b = 0; b < 8; b++) {
      const lat = b < 3 ? 20 : b < 5 ? 500 : tailMs;
      for (let i = 0; i < 20; i++) rs.push(op("committed", lat, b * 1000));
    }
    return bucketize(rs, 1000);
  };
  const good = findRecovery(build(20), { spikeStartMs: 3000, spikeEndMs: 5000 })!;
  assert.equal(good.recovered, true);
  assert.equal(good.baselineP99, 20);
  assert.equal(good.peakP99, 500);
  assert.equal(good.recoveredAfterMs, 0); // recovered in the first bucket after

  const bad = findRecovery(build(400), { spikeStartMs: 3000, spikeEndMs: 5000 })!;
  assert.equal(bad.recovered, false);
  assert.equal(bad.recoveredAfterMs, undefined);
});

test("findBreakingPoint names where AND how the system broke", () => {
  const results: OpResult[] = [];
  for (let b = 0; b < 6; b++) {
    for (let i = 0; i < 20; i++) {
      const broken = b >= 4;
      results.push(
        broken && i > 4
          ? op("contention", 900, b * 1000, "LOCAL_VERDICT_LOCKED: locked by a concurrent transaction")
          : op("committed", 30, b * 1000),
      );
    }
  }
  const bp = findBreakingPoint(results, bucketize(results, 1000))!;
  assert.equal(bp.atMs, 4000);
  assert.match(bp.failureMode, /LOCAL_VERDICT_LOCKED/);
  assert.ok(bp.contentionRate > 0.5);

  // A healthy run has no breaking point.
  const healthy = many(120, (i) => op("committed", 30, Math.floor(i / 20) * 1000));
  assert.equal(findBreakingPoint(healthy, bucketize(healthy, 1000)), undefined);
});

test("dominantFailure groups by Canton error code", () => {
  const rs = [
    op("contention", 1, 0, "LOCAL_VERDICT_LOCKED: a"),
    op("contention", 1, 0, "LOCAL_VERDICT_LOCKED: b"),
    op("rejected", 1, 0, "DAML_AUTHORIZATION_ERROR: c"),
    op("committed", 1, 0),
  ];
  assert.equal(dominantFailure(rs), "LOCAL_VERDICT_LOCKED (2×)");
  assert.equal(dominantFailure([op("committed", 1, 0)]), "none");
});

// ---- end to end through analyseMode ---------------------------------------

test("analyseMode produces the verdict each mode exists to produce", () => {
  const rampSpec: ModeSpec = { mode: "ramp", durationMs: 10_000, fromRate: 5, toRate: 50, bucketMs: 1000, warmupMs: 0 };
  const ramping = many(200, (i) => {
    const b = Math.floor(i / 20);
    return op("committed", b < 5 ? 20 : 400, b * 1000);
  });
  const ramp = analyseMode(rampSpec, ramping);
  assert.ok(ramp.knee, "ramp should find the knee");
  assert.match(ramp.verdict, /latency knee at/);

  // A ramp that finds nothing must SAY it found nothing, and suggest ramping
  // higher — not manufacture a capacity number.
  const flat = many(200, (i) => op("committed", 20, Math.floor(i / 20) * 1000));
  assert.match(analyseMode(rampSpec, flat).verdict, /no clean knee or cliff.*ramp higher/s);

  // But a run that found no clean inflection while the system REFUSED a large
  // share of the load must not report "no limit found" — it is already past it.
  const shedding = many(200, (i) => {
    const b = Math.floor(i / 20);
    return i % 5 === 0
      ? op("committed", 30, b * 1000)
      : op("rejected", 30, b * 1000, "PARTICIPANT_BACKPRESSURE: too many in flight");
  });
  const v = analyseMode(rampSpec, shedding).verdict;
  assert.match(v, /80% of offered load was refused/);
  assert.match(v, /PARTICIPANT_BACKPRESSURE/);
  assert.match(v, /already past its limit/);

  const soakSpec: ModeSpec = { mode: "soak", durationMs: 20_000, fromRate: 10, toRate: 10, bucketMs: 1000, warmupMs: 0 };
  const steady = many(400, (i) => op("committed", 50, Math.floor(i / 20) * 1000));
  assert.match(analyseMode(soakSpec, steady).verdict, /stable over 20s/);

  const spikeSpec: ModeSpec = {
    mode: "spike", durationMs: 8000, fromRate: 5, toRate: 50, spikeStartMs: 3000, spikeMs: 2000, bucketMs: 1000, warmupMs: 0,
  };
  const rs: OpResult[] = [];
  for (let b = 0; b < 8; b++)
    for (let i = 0; i < 20; i++) rs.push(op("committed", b < 3 ? 20 : b < 5 ? 500 : 20, b * 1000));
  assert.match(analyseMode(spikeSpec, rs).verdict, /recovered/);
});

test("defaultSpec makes each mode do something sensible with just a rate", () => {
  const ramp = defaultSpec("ramp", { rate: 100 });
  assert.ok(ramp.fromRate < ramp.toRate && ramp.toRate === 100);
  // Stress must overshoot the requested rate or it can never find a limit.
  const stress = defaultSpec("stress", { rate: 100 });
  assert.ok(stress.toRate > 100);
  const spike = defaultSpec("spike", { rate: 10 });
  assert.ok(spike.toRate > spike.fromRate && spike.spikeStartMs! > 0 && spike.spikeMs! > 0);
  // Soak defaults to a long window at a flat rate.
  const soak = defaultSpec("soak", { rate: 10 });
  assert.equal(soak.fromRate, soak.toRate);
  assert.ok(soak.durationMs >= 300_000);
});

