// The load scheduler — the measurement core (roadmap S3). Two models:
//
//   CLOSED  — keep `concurrency` operations in flight at all times. Latency is
//             the real submit→complete time. The model is self-pacing (a new
//             op starts only when a slot frees), so there is no scheduled
//             arrival time and nothing to correct.
//
//   OPEN    — operations ARRIVE at a fixed rate: op i is scheduled for
//             t0 + i*gap, dispatched as close to its slot as possible, with a
//             max-in-flight cap for backpressure. Latency is measured from the
//             SCHEDULED start, NOT the actual dispatch.
//
// That last point is the whole game. It is the **coordinated-omission**
// correction (Gil Tene): when the system can't keep up, a naive load tester
// stops sending, waits for the slow op, and then reports only the *service
// time* of the next op — hiding the queue the op actually sat in. By charging
// each op the delay from its intended arrival slot, a backlog shows up as the
// tail latency a user would really experience. A load tool that gets this
// wrong is dismissed by any serious performance engineer, so it is isolated
// here behind an injectable clock and tested deterministically.

import { classifyOutcome, type OpAttribution, type OpResult } from "./metrics.ts";

export interface SubmitOutcome {
  ok: boolean;
  error?: string;
  /** [S4] What the op touched, for per-contract / per-party attribution. The
   * scheduler just carries it through — it stays agnostic about workloads. */
  attribution?: OpAttribution;
}

/** Runs one operation (index i) and resolves when it commits or is rejected. */
export type Task = (i: number) => Promise<SubmitOutcome>;

/** Where every result is reported as it happens, so a caller can aggregate
 * (histogram, counters) without the scheduler retaining anything.
 *
 * Retention is what breaks at scale: one object per operation is fine for a
 * 60-second run and is gigabytes at ten million. The sink sees ALL results;
 * the returned array keeps at most `maxRetained` of them, for attribution. */
export type ResultSink = (r: OpResult) => void;

/** Injectable clock so the coordinated-omission logic is testable in virtual
 * time. Defaults to the real monotonic clock. */
export interface Clock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export const realClock: Clock = {
  now: () => performance.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms))),
};

export interface OpenResult {
  results: OpResult[];
  /** Measured operations actually achieved per second (vs the target rate). */
  achievedRatePerSec: number;
  wallMs: number;
  /** Operations actually dispatched, warmup included. */
  dispatched: number;
}

/** [S5] Offered load over time. A constant is the steady-state case; a function
 * of elapsed ms is what makes ramp / spike / stress possible. */
export type RateSchedule = number | ((elapsedMs: number) => number);

export const rateAt = (r: RateSchedule, elapsedMs: number): number =>
  typeof r === "number" ? r : r(elapsedMs);

/** A run stops at whichever limit comes first. `durationMs` is what soak and
 * spike need: their length is a time, not an operation count. */
export interface StopWhen {
  count?: number;
  durationMs?: number;
}

/** Operations excluded from measurement while the system warms up (JIT,
 * caches, connection pools). Either form; both are honoured. */
export interface Warmup {
  /** Discard the first N operations. */
  count?: number;
  /** Discard everything in the first N ms of the window. */
  ms?: number;
}

const isWarmup = (w: Warmup, i: number, elapsedMs: number): boolean =>
  (w.count !== undefined && i < w.count) || (w.ms !== undefined && elapsedMs < w.ms);

/** CLOSED model: a fixed number of workers, each pulling the next op as soon
 * as it finishes the previous. Latency = actual service time. */
export async function runClosed(o: {
  count?: number;
  warmup: number | Warmup;
  concurrency: number;
  /** Stop after this long regardless of count — soak runs are timed. */
  durationMs?: number;
  task: Task;
  clock?: Clock;
  onResult?: ResultSink;
  maxRetained?: number;
}): Promise<OpResult[]> {
  const clock = o.clock ?? realClock;
  const warmup: Warmup = typeof o.warmup === "number" ? { count: o.warmup } : o.warmup;
  const results: OpResult[] = [];
  const retain = o.maxRetained ?? Infinity;
  const t0 = clock.now();
  const limit = o.count ?? Infinity;
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= limit) return;
      const start = clock.now();
      if (o.durationMs !== undefined && start - t0 >= o.durationMs) return;
      const r = await o.task(i);
      const latencyMs = clock.now() - start;
      if (!isWarmup(warmup, i, start - t0)) {
        const res: OpResult = {
          outcome: classifyOutcome(r),
          latencyMs,
          error: r.error,
          attribution: r.attribution,
          atMs: start - t0,
        };
        o.onResult?.(res);
        if (results.length < retain) results.push(res);
      }
    }
  };
  const workers = Math.max(1, Math.min(o.concurrency, limit === Infinity ? o.concurrency : limit));
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}

/** OPEN model: arrivals follow a rate SCHEDULE, with coordinated-omission-
 * correct latency.
 *
 * [S5] The schedule may vary with time, which is what makes ramp / spike /
 * stress possible. Arrival times are integrated from it incrementally — the
 * gap before each arrival is 1000/r(t) at that point — rather than assuming
 * one fixed gap. The approximation is exact for a constant rate and accurate
 * whenever the rate changes slowly relative to the gap, which holds for the
 * profiles here (a ramp over seconds, arrivals milliseconds apart).
 *
 * The crucial property is unchanged: each arrival time is decided by the
 * SCHEDULE, never by when dispatch actually happened, and latency is charged
 * from that intended time. A system falling behind therefore accumulates
 * visible tail latency instead of quietly slowing the load generator down. */
export async function runOpen(o: {
  count?: number;
  warmup: number | Warmup;
  ratePerSec: RateSchedule;
  maxInFlight: number;
  /** Stop after this long regardless of count. */
  durationMs?: number;
  task: Task;
  clock?: Clock;
  onResult?: ResultSink;
  maxRetained?: number;
}): Promise<OpenResult> {
  const clock = o.clock ?? realClock;
  const warmup: Warmup = typeof o.warmup === "number" ? { count: o.warmup } : o.warmup;
  const t0 = clock.now();
  const results: OpResult[] = [];
  const retain = o.maxRetained ?? Infinity;
  let measured = 0;
  const inFlight = new Set<Promise<void>>();
  const limit = o.count ?? Infinity;

  let intended = t0; // the first arrival is due immediately
  let dispatched = 0;
  for (let i = 0; i < limit; i++) {
    const elapsed = intended - t0;
    if (o.durationMs !== undefined && elapsed >= o.durationMs) break;

    const wait = intended - clock.now();
    if (wait > 0) await clock.sleep(wait);
    // Backpressure: never exceed maxInFlight. Ops blocked here are still
    // charged the wait, because latency is measured from `intended`.
    while (inFlight.size >= o.maxInFlight) await Promise.race(inFlight);

    const at = intended; // capture: the loop advances it below
    const isMeasured = !isWarmup(warmup, i, elapsed);
    const p: Promise<void> = (async () => {
      const r = await o.task(i);
      const latencyMs = clock.now() - at; // <-- coordinated-omission correct
      if (isMeasured) {
        const res: OpResult = {
          outcome: classifyOutcome(r),
          latencyMs,
          error: r.error,
          attribution: r.attribution,
          atMs: at - t0,
        };
        measured++;
        o.onResult?.(res);
        if (results.length < retain) results.push(res);
      }
    })();
    const tracked: Promise<void> = p.finally(() => inFlight.delete(tracked));
    inFlight.add(tracked);
    dispatched++;

    // Advance to the next scheduled arrival using the rate in force NOW.
    // Guard against a zero/negative rate producing a non-advancing schedule.
    const r = Math.max(1e-6, rateAt(o.ratePerSec, intended - t0));
    intended += 1000 / r;
  }
  await Promise.all(inFlight);

  const wallMs = clock.now() - t0;
  return {
    results,
    // Measured ops only: warmup is excluded from the rate the run achieved.
    achievedRatePerSec: wallMs > 0 ? measured / (wallMs / 1000) : 0,
    wallMs,
    dispatched,
  };
}
