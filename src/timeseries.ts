// Behaviour over TIME (roadmap S5).
//
// A single steady run collapses a whole test into one row of numbers. The
// questions capacity planning actually asks are about change: where does
// latency start to bend, where does throughput stop growing, does p99 creep up
// over an eight-hour soak, how long after a burst does the system come back.
// None of those are answerable without a timeline, so results are bucketed
// here and every mode's verdict is derived from the buckets.
//
// Everything in this file is pure and returns `undefined` when the data does
// not support a conclusion. That matters more than it sounds: a tool that
// always reports a knee will report one in noise, and a capacity number
// invented from noise is worse than no number at all.

import { percentile, type OpResult, type Outcome } from "./metrics.ts";

export interface Bucket {
  /** Bucket start, ms from the beginning of the measured window. */
  tMs: number;
  ops: number;
  committed: number;
  contention: number;
  rejected: number;
  /** Committed per second within the bucket. */
  throughputPerSec: number;
  /** All attempts per second within the bucket — the load that was offered. */
  offeredPerSec: number;
  contentionRate: number;
  p50: number;
  p99: number;
}

/** Group results into fixed time buckets. Operations carry the position they
 * were SCHEDULED at (see OpResult.atMs), so buckets describe the load that was
 * demanded rather than the order the system got round to answering in. */
export function bucketize(results: OpResult[], bucketMs: number): Bucket[] {
  if (bucketMs <= 0) throw new Error("bucketMs must be > 0");
  const timed = results.filter((r) => r.atMs !== undefined);
  if (timed.length === 0) return [];
  const lastT = Math.max(...timed.map((r) => r.atMs!));
  const n = Math.floor(lastT / bucketMs) + 1;
  const groups: OpResult[][] = Array.from({ length: n }, () => []);
  for (const r of timed) groups[Math.floor(r.atMs! / bucketMs)].push(r);

  const secs = bucketMs / 1000;
  return groups.map((rs, i) => {
    const count = (o: Outcome) => rs.filter((r) => r.outcome === o).length;
    const lat = rs.map((r) => r.latencyMs).sort((a, b) => a - b);
    const committed = count("committed");
    return {
      tMs: i * bucketMs,
      ops: rs.length,
      committed,
      contention: count("contention"),
      rejected: count("rejected"),
      throughputPerSec: committed / secs,
      offeredPerSec: rs.length / secs,
      contentionRate: rs.length > 0 ? count("contention") / rs.length : 0,
      p50: percentile(lat, 50),
      p99: percentile(lat, 99),
    };
  });
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** Buckets with too few samples to say anything are ignored by the analyses:
 * a p99 over three operations is not a p99. */
const MIN_SAMPLES = 5;
const usable = (bs: Bucket[]): Bucket[] => bs.filter((b) => b.ops >= MIN_SAMPLES);

// ---- ramp: the latency knee and the throughput cliff -----------------------

export interface Knee {
  atMs: number;
  /** Offered load where latency began to bend. */
  offeredPerSec: number;
  p99: number;
  baselineP99: number;
}

/** The latency knee: the first point where p99 rises past `factor`× the early
 * baseline and STAYS there (a single bad bucket is noise, not a knee). */
export function findKnee(buckets: Bucket[], factor = 3): Knee | undefined {
  const bs = usable(buckets);
  if (bs.length < 4) return undefined;
  // Baseline from the first quarter of the run, where load is still light.
  const head = bs.slice(0, Math.max(1, Math.floor(bs.length / 4)));
  const baselineP99 = median(head.map((b) => b.p99));
  if (baselineP99 <= 0) return undefined;

  for (let i = head.length; i < bs.length; i++) {
    if (bs[i].p99 <= baselineP99 * factor) continue;
    // Require the next bucket to agree, so one outlier cannot declare a knee.
    const next = bs[i + 1];
    if (next && next.p99 <= baselineP99 * factor) continue;
    return {
      atMs: bs[i].tMs,
      offeredPerSec: bs[i].offeredPerSec,
      p99: bs[i].p99,
      baselineP99,
    };
  }
  return undefined;
}

export interface Cliff {
  atMs: number;
  /** Offered load at the point throughput stopped growing. */
  offeredPerSec: number;
  /** The best throughput the system reached. */
  peakThroughputPerSec: number;
}

/** The throughput cliff: the offered load beyond which pushing harder stops
 * buying throughput. Reported only when the run actually pushed past it —
 * otherwise the peak is just the end of the ramp, which says nothing. */
export function findCliff(buckets: Bucket[], tolerance = 0.9): Cliff | undefined {
  const bs = usable(buckets);
  if (bs.length < 4) return undefined;
  let peak = bs[0];
  for (const b of bs) if (b.throughputPerSec > peak.throughputPerSec) peak = b;

  const after = bs.filter((b) => b.tMs > peak.tMs);
  if (after.length < 2) return undefined; // never pushed beyond the peak

  // A cliff means "we asked for more and got no more". Without evidence that
  // offered load actually ROSE after the peak there is no cliff — only a flat
  // run, which would otherwise report a bogus cliff in its very first bucket.
  const pushedHarder = after.some((b) => b.offeredPerSec > peak.offeredPerSec * 1.1);
  if (!pushedHarder) return undefined;

  // Confirm throughput really stalled after the peak rather than wobbling.
  const stalled = after.every((b) => b.throughputPerSec <= peak.throughputPerSec * (1 / tolerance));
  const roseFurther = after.some((b) => b.throughputPerSec > peak.throughputPerSec * 1.05);
  if (!stalled || roseFurther) return undefined;

  return {
    atMs: peak.tMs,
    offeredPerSec: peak.offeredPerSec,
    peakThroughputPerSec: peak.throughputPerSec,
  };
}

// ---- soak: drift -----------------------------------------------------------

export interface Drift {
  /** Percent change in p99 from the first quarter to the last. */
  p99ChangePct: number;
  /** Percent change in committed throughput over the same span. */
  throughputChangePct: number;
  firstP99: number;
  lastP99: number;
  firstThroughput: number;
  lastThroughput: number;
  /** True when latency grew or throughput fell beyond the tolerance. */
  degraded: boolean;
}

/** Compare the start of a long run with its end. A soak is not about the
 * headline percentile — it is about whether the system is the same system an
 * hour later. Leaks, unbounded queues and index growth all show up here and
 * nowhere else. */
export function findDrift(buckets: Bucket[], tolerancePct = 25): Drift | undefined {
  const bs = usable(buckets);
  if (bs.length < 4) return undefined;
  const q = Math.max(1, Math.floor(bs.length / 4));
  const first = bs.slice(0, q);
  const last = bs.slice(-q);

  const firstP99 = median(first.map((b) => b.p99));
  const lastP99 = median(last.map((b) => b.p99));
  const firstThroughput = median(first.map((b) => b.throughputPerSec));
  const lastThroughput = median(last.map((b) => b.throughputPerSec));

  const p99ChangePct = firstP99 > 0 ? (lastP99 / firstP99 - 1) * 100 : 0;
  const throughputChangePct =
    firstThroughput > 0 ? (lastThroughput / firstThroughput - 1) * 100 : 0;

  return {
    p99ChangePct,
    throughputChangePct,
    firstP99,
    lastP99,
    firstThroughput,
    lastThroughput,
    degraded: p99ChangePct > tolerancePct || throughputChangePct < -tolerancePct,
  };
}

// ---- spike: recovery -------------------------------------------------------

export interface Recovery {
  /** Baseline p99 measured before the burst. */
  baselineP99: number;
  /** Worst p99 seen during or after the burst. */
  peakP99: number;
  /** Time from the end of the burst until p99 came back within tolerance. */
  recoveredAfterMs?: number;
  /** False when the run ended with latency still elevated. */
  recovered: boolean;
}

/** How a system behaves after a burst — does it shed the backlog and return to
 * baseline, and how long does that take? A system that never recovers within
 * the run is the interesting failure: the queue outlived the load. */
export function findRecovery(
  buckets: Bucket[],
  o: { spikeStartMs: number; spikeEndMs: number; tolerance?: number },
): Recovery | undefined {
  const bs = usable(buckets);
  if (bs.length < 3) return undefined;
  const tolerance = o.tolerance ?? 1.5;
  const before = bs.filter((b) => b.tMs < o.spikeStartMs);
  if (before.length === 0) return undefined;
  // Take the baseline from the steady state IMMEDIATELY before the burst, not
  // from the whole pre-spike window. Measured against a real sandbox, the
  // JVM/connection transient outlasts the warm-up window and inflates an
  // average-of-everything baseline — which then makes any recovery look
  // instant, because the bar was set at the transient's height.
  const settled = before.slice(Math.floor(before.length / 2));
  const baselineP99 = median(settled.map((b) => b.p99));
  if (baselineP99 <= 0) return undefined;

  const during = bs.filter((b) => b.tMs >= o.spikeStartMs);
  const peakP99 = during.length > 0 ? Math.max(...during.map((b) => b.p99)) : baselineP99;

  const after = bs.filter((b) => b.tMs >= o.spikeEndMs);
  for (const b of after) {
    if (b.p99 <= baselineP99 * tolerance)
      return {
        baselineP99,
        peakP99,
        recoveredAfterMs: b.tMs - o.spikeEndMs,
        recovered: true,
      };
  }
  return { baselineP99, peakP99, recovered: false };
}

// ---- stress: the breaking point -------------------------------------------

export interface BreakingPoint {
  atMs: number;
  /** Offered load at which the system stopped keeping up. */
  offeredPerSec: number;
  /** What went wrong there: the dominant outcome and error text. */
  failureMode: string;
  contentionRate: number;
}

/** Where the system broke, and HOW. The failure mode is the point of a stress
 * test: "it fell over at 40/s" is far less useful than "at 40/s it stopped
 * committing and every rejection was contention". */
export function findBreakingPoint(
  results: OpResult[],
  buckets: Bucket[],
  failureRate = 0.5,
): BreakingPoint | undefined {
  const bs = usable(buckets);
  if (bs.length === 0) return undefined;
  // Bucket width, recovered from the series itself.
  const width = buckets.length > 1 ? buckets[1].tMs - buckets[0].tMs : Infinity;

  for (const b of bs) {
    const badRate = (b.contention + b.rejected) / Math.max(1, b.ops);
    if (badRate < failureRate) continue;
    const inBucket = results.filter(
      (r) => r.atMs !== undefined && r.atMs >= b.tMs && r.atMs < b.tMs + width,
    );
    return {
      atMs: b.tMs,
      offeredPerSec: b.offeredPerSec,
      // Diagnose from the failing bucket itself; earlier healthy traffic would
      // dilute the signal we actually want.
      failureMode: dominantFailure(inBucket.length > 0 ? inBucket : results),
      contentionRate: b.contentionRate,
    };
  }
  return undefined;
}

/** The most common failure text, trimmed to something readable. */
export function dominantFailure(results: OpResult[]): string {
  const counts = new Map<string, number>();
  for (const r of results) {
    if (r.outcome === "committed" || !r.error) continue;
    // Canton error codes lead the cause string; group on the code when present.
    const code = /^([A-Z][A-Z0-9_]{3,})/.exec(r.error)?.[1] ?? r.error.slice(0, 60);
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  if (counts.size === 0) return "none";
  const [top] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return `${top[0]} (${top[1]}×)`;
}
