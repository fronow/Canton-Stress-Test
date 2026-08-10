// Test modes (roadmap S5): ramp, soak, spike, stress.
//
// Capacity planning and SLA validation ARE these modes — a single steady run
// is not a test, it is one data point. Each mode here is a rate PROFILE over
// the one primitive S5 added (a time-varying arrival rate, `RateSchedule`),
// plus the verdict that mode exists to produce:
//
//   ramp    load climbing from A to B      → where is the knee / the cliff?
//   soak    a constant rate, for a long time → does it drift?
//   spike   baseline, a burst, baseline     → does it recover, and how fast?
//   stress  climbing past the limit         → where does it break, and how?
//
// All four are open-model by construction. Offered load is the independent
// variable, and a closed model has none: it self-paces, so "increase the load"
// is not a thing you can ask it to do. Soak is the exception — holding N
// operations in flight for an hour is a legitimate endurance test — so it is
// allowed in both.

import type { RateSchedule } from "./schedule.ts";
import {
  bucketize,
  dominantFailure,
  findBreakingPoint,
  findCliff,
  findDrift,
  findKnee,
  findRecovery,
  type Bucket,
  type BreakingPoint,
  type Cliff,
  type Drift,
  type Knee,
  type Recovery,
} from "./timeseries.ts";
import type { OpResult } from "./metrics.ts";

export type ModeName = "ramp" | "soak" | "spike" | "stress";

export interface ModeSpec {
  mode: ModeName;
  /** Total length of the measured window. */
  durationMs: number;
  /** ramp/stress: starting rate. spike: the baseline rate. */
  fromRate: number;
  /** ramp/stress: ending rate. spike: the burst rate. */
  toRate: number;
  /** spike: when the burst starts and how long it lasts. */
  spikeStartMs?: number;
  spikeMs?: number;
  /** Width of a time-series bucket. */
  bucketMs: number;
  /** Discard this much of the start of the window.
   *
   * Not optional in practice: the first seconds of a JVM-backed ledger are
   * dominated by JIT and connection warm-up, and a measured run showed the
   * FIRST bucket carrying the highest p99 of the whole test (7.4s against a
   * ~400ms steady state). Left in, that spike becomes the baseline the knee is
   * measured against and no real knee can ever exceed it. */
  warmupMs: number;
}

/** Sensible defaults per mode, so `--mode ramp` alone does something useful. */
export function defaultSpec(mode: ModeName, o: { rate: number; durationMs?: number }): ModeSpec {
  const durationMs = o.durationMs ?? (mode === "soak" ? 300_000 : 60_000);
  const bucketMs = Math.max(1000, Math.round(durationMs / 30));
  // Warm-up: at least a bucket, and about a tenth of the run. A measured
  // sandbox took ~6-9s to settle — longer than one bucket of a 60s test — and
  // the leftover transient is precisely what corrupts a baseline.
  const warmupMs = Math.max(bucketMs, Math.round(durationMs / 10));
  switch (mode) {
    case "ramp":
      // Climb to the requested rate: the run is a search for the limit, so the
      // target is the top of the range, not a steady state.
      return { mode, durationMs, fromRate: Math.max(1, o.rate / 10), toRate: o.rate, bucketMs, warmupMs };
    case "stress":
      // Deliberately overshoot — a stress test that never breaks the system
      // has not found anything.
      return { mode, durationMs, fromRate: Math.max(1, o.rate / 5), toRate: o.rate * 4, bucketMs, warmupMs };
    case "spike": {
      const spikeStartMs = Math.round(durationMs / 3);
      return {
        mode,
        durationMs,
        fromRate: o.rate,
        toRate: o.rate * 5,
        spikeStartMs,
        spikeMs: Math.round(durationMs / 6),
        bucketMs,
        warmupMs,
      };
    }
    case "soak":
      return { mode, durationMs, fromRate: o.rate, toRate: o.rate, bucketMs, warmupMs };
  }
}

/** The rate profile for a mode: elapsed ms → offered ops/sec. */
export function rateSchedule(spec: ModeSpec): RateSchedule {
  switch (spec.mode) {
    case "soak":
      return spec.fromRate;
    case "ramp":
    case "stress": {
      const { fromRate, toRate, durationMs } = spec;
      return (t: number) => {
        const frac = durationMs > 0 ? Math.min(1, Math.max(0, t / durationMs)) : 1;
        return fromRate + (toRate - fromRate) * frac;
      };
    }
    case "spike": {
      const start = spec.spikeStartMs ?? Math.round(spec.durationMs / 3);
      const end = start + (spec.spikeMs ?? Math.round(spec.durationMs / 6));
      return (t: number) => (t >= start && t < end ? spec.toRate : spec.fromRate);
    }
  }
}

/** What a mode run concluded. Every field is optional on purpose: when the run
 * did not produce evidence for a verdict, it says nothing rather than
 * inventing a number. */
export interface ModeReport {
  mode: ModeName;
  spec: ModeSpec;
  buckets: Bucket[];
  knee?: Knee;
  cliff?: Cliff;
  drift?: Drift;
  recovery?: Recovery;
  breakingPoint?: BreakingPoint;
  /** Plain-language summary of what the run showed. */
  verdict: string;
}

const r1 = (n: number): number => Math.round(n * 10) / 10;

/** Analyse a finished mode run. */
export function analyseMode(spec: ModeSpec, results: OpResult[]): ModeReport {
  const buckets = bucketize(results, spec.bucketMs);
  const base: ModeReport = { mode: spec.mode, spec, buckets, verdict: "" };

  switch (spec.mode) {
    case "ramp": {
      const knee = findKnee(buckets);
      const cliff = findCliff(buckets);
      return {
        ...base,
        knee,
        cliff,
        verdict: rampVerdict(knee, cliff, spec, results),
      };
    }
    case "stress": {
      const breakingPoint = findBreakingPoint(results, buckets);
      const cliff = findCliff(buckets);
      return {
        ...base,
        breakingPoint,
        cliff,
        verdict: breakingPoint
          ? `broke at ~${r1(breakingPoint.offeredPerSec)} ops/s offered — ` +
            `${r1(breakingPoint.contentionRate * 100)}% contention, dominant failure ${breakingPoint.failureMode}`
          : `no breaking point up to ${r1(spec.toRate)} ops/s offered — ` +
            `the system absorbed everything this run asked of it` +
            (results.length > 0 ? ` (dominant rejection: ${dominantFailure(results)})` : ""),
      };
    }
    case "soak": {
      const drift = findDrift(buckets);
      return {
        ...base,
        drift,
        verdict: !drift
          ? "run too short to judge drift"
          : drift.degraded
            ? `DEGRADED over ${r1(spec.durationMs / 1000)}s — p99 ${signed(drift.p99ChangePct)}%, ` +
              `throughput ${signed(drift.throughputChangePct)}%`
            : `stable over ${r1(spec.durationMs / 1000)}s — p99 ${signed(drift.p99ChangePct)}%, ` +
              `throughput ${signed(drift.throughputChangePct)}%`,
      };
    }
    case "spike": {
      const start = spec.spikeStartMs ?? Math.round(spec.durationMs / 3);
      const end = start + (spec.spikeMs ?? Math.round(spec.durationMs / 6));
      const recovery = findRecovery(buckets, { spikeStartMs: start, spikeEndMs: end });
      return {
        ...base,
        recovery,
        verdict: !recovery
          ? "not enough baseline before the burst to judge recovery"
          : recovery.recovered
            ? `recovered ${r1((recovery.recoveredAfterMs ?? 0) / 1000)}s after the burst ` +
              `(p99 ${r1(recovery.baselineP99)}ms → peak ${r1(recovery.peakP99)}ms → baseline)`
            : `DID NOT RECOVER within the run — p99 peaked at ${r1(recovery.peakP99)}ms ` +
              `against a ${r1(recovery.baselineP99)}ms baseline and stayed elevated`,
      };
    }
  }
}

const signed = (n: number): string => `${n >= 0 ? "+" : ""}${r1(n)}`;

function rampVerdict(
  knee: Knee | undefined,
  cliff: Cliff | undefined,
  spec: ModeSpec,
  results: OpResult[],
): string {
  // A system shedding a large share of the offered load is past its limit
  // whether or not the knee/cliff heuristics could confirm a clean inflection.
  // Reporting "no knee found" alone, while 38% of submissions were refused,
  // would be technically true and practically misleading.
  const bad = results.filter((r) => r.outcome !== "committed").length;
  const badPct = results.length > 0 ? (bad / results.length) * 100 : 0;
  const shedding =
    badPct >= 10
      ? ` — but ${r1(badPct)}% of offered load was refused (${dominantFailure(results)}), ` +
        `so the system is already past its limit in this range`
      : "";

  if (!knee && !cliff)
    return (
      `no clean knee or cliff between ${r1(spec.fromRate)} and ${r1(spec.toRate)} ops/s` +
      (shedding || ` — capacity is above this range, so ramp higher to find it`)
    );
  const parts: string[] = [];
  if (knee)
    parts.push(
      `latency knee at ~${r1(knee.offeredPerSec)} ops/s offered ` +
        `(p99 ${r1(knee.baselineP99)}ms → ${r1(knee.p99)}ms)`,
    );
  if (cliff)
    parts.push(
      `throughput cliff at ~${r1(cliff.offeredPerSec)} ops/s offered ` +
        `(peaks at ${r1(cliff.peakThroughputPerSec)} committed/s)`,
    );
  return parts.join("; ") + shedding;
}

/** Human-readable mode block for the console. */
export function formatMode(m: ModeReport): string {
  const out = [`  ${m.mode}: ${m.verdict}`];
  // A compact sparkline of the run, so the shape is visible without the HTML.
  const bs = m.buckets.filter((b) => b.ops > 0);
  if (bs.length > 1) {
    const maxT = Math.max(...bs.map((b) => b.throughputPerSec), 1);
    const maxP = Math.max(...bs.map((b) => b.p99), 1);
    out.push(`  offered → throughput / p99 by ${r1(m.spec.bucketMs / 1000)}s bucket:`);
    out.push(`    ${spark(bs.map((b) => b.throughputPerSec), maxT)}  throughput (max ${r1(maxT)}/s)`);
    out.push(`    ${spark(bs.map((b) => b.p99), maxP)}  p99 (max ${r1(maxP)}ms)`);
  }
  return out.join("\n");
}

const BLOCKS = "▁▂▃▄▅▆▇█";
const spark = (xs: number[], max: number): string =>
  xs
    .map((x) => BLOCKS[Math.min(BLOCKS.length - 1, Math.floor((x / max) * (BLOCKS.length - 1)))])
    .join("");
