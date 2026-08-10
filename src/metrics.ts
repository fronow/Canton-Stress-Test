// Metrics for a load run: per-operation outcome + latency, aggregated into the
// numbers an SLA cares about (percentiles, throughput, contention rate).
//
// The Canton-specific bit is classifying REJECTIONS: under concurrency, the
// interesting failure is contention (two transactions raced on the same
// contract) — that is the real scaling limit for a hot contract, and it must
// not be confused with slowness or with ordinary validation errors.

export type Outcome = "committed" | "contention" | "rejected";

/** [S4] What an operation actually touched. Carried alongside the latency so a
 * global contention rate can be decomposed into "WHICH contract is serializing
 * you" and "which party is seeing the tail". */
export interface OpAttribution {
  template: string;
  choice?: string;
  /** The contract an exercise targeted (absent for creates). */
  contractId?: string;
  /** Contracts passed as ARGUMENTS to the choice.
   *
   * Factory-shaped apps — the whole Token Standard family — exercise a
   * long-lived, nonconsuming factory and pass the contracts that actually get
   * archived as arguments. Attributing only to the exercise target then names
   * the factory as the hotspot when the real conflict is over an input
   * holding. Measured against two registries: 100% of contention attributed to
   * a factory that, being nonconsuming, cannot conflict at all. */
  argumentContractIds?: string[];
  /** Submitting parties. */
  parties: string[];
}

export interface OpResult {
  outcome: Outcome;
  /** submit → commit (committed) or submit → rejection (otherwise), in ms. */
  latencyMs: number;
  error?: string;
  attribution?: OpAttribution;
  /** [S5] Where this operation sits in the measured window, in ms from its
   * start. For the open model this is the op's SCHEDULED arrival — the offered-
   * load timeline — so a time series describes the load that was demanded, not
   * the order the system happened to answer in. */
  atMs?: number;
}

export interface Summary {
  ops: number;
  committed: number;
  contention: number;
  rejected: number;
  wallMs: number;
  /** committed transactions per second over the wall-clock window. */
  throughputPerSec: number;
  /** all attempts per second (committed + contention + rejected). */
  attemptedPerSec: number;
  /** contention rejections as a fraction of all attempts. */
  contentionRate: number;
  latency: {
    p50: number;
    p90: number;
    p95: number;
    p99: number;
    max: number;
    mean: number;
  };
  /** Percentile curve for charts: [{p:50,ms}, {p:75,ms}, …]. */
  latencyCurve: { p: number; ms: number }[];
}

const CURVE_PS = [50, 75, 90, 95, 99, 99.9];

// Canton contention / race signals (self-service error codes lead the cause
// string; message fragments are the fallback for older payloads).
const CONTENTION =
  /LOCAL_VERDICT_LOCKED|CONTENTION|INCONSISTENT|contention|locked|CONTRACT_NOT_FOUND|already (been )?(archived|consumed|inactive)|DUPLICATE_CONTRACT_KEY|racing|out[- ]of[- ]date/i;

/** Classify one submission's outcome. A committed transaction is throughput; a
 * contention rejection is a race (the scaling signal); anything else is an
 * ordinary rejection (bad args, auth, precondition). */
export function classifyOutcome(res: { ok: boolean; error?: string }): Outcome {
  if (res.ok) return "committed";
  return CONTENTION.test(res.error ?? "") ? "contention" : "rejected";
}

/** Nearest-rank percentile over an ASCENDING-sorted array. */
export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, rank - 1));
  return sortedAsc[idx];
}

export function summarize(results: OpResult[], wallMs: number): Summary {
  const lat = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const count = (o: Outcome) => results.filter((r) => r.outcome === o).length;
  const committed = count("committed");
  const contention = count("contention");
  const rejected = count("rejected");
  const secs = wallMs / 1000;
  const mean = lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : 0;
  return {
    ops: results.length,
    committed,
    contention,
    rejected,
    wallMs,
    throughputPerSec: secs > 0 ? committed / secs : 0,
    attemptedPerSec: secs > 0 ? results.length / secs : 0,
    contentionRate: results.length ? contention / results.length : 0,
    latency: {
      p50: percentile(lat, 50),
      p90: percentile(lat, 90),
      p95: percentile(lat, 95),
      p99: percentile(lat, 99),
      max: lat.length ? lat[lat.length - 1] : 0,
      mean,
    },
    latencyCurve: CURVE_PS.map((p) => ({ p, ms: percentile(lat, p) })),
  };
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** One-block human summary for the console. */
export function formatSummary(s: Summary): string {
  return [
    `  ops:          ${s.ops} (${s.committed} committed, ${s.contention} contention, ${s.rejected} rejected)`,
    `  throughput:   ${r1(s.throughputPerSec)} committed/s  (${r1(s.attemptedPerSec)} attempted/s)`,
    `  contention:   ${r1(s.contentionRate * 100)}%`,
    `  latency (ms): p50 ${r1(s.latency.p50)}  p90 ${r1(s.latency.p90)}  p95 ${r1(s.latency.p95)}  p99 ${r1(s.latency.p99)}  max ${r1(s.latency.max)}`,
  ].join("\n");
}
