// Distributed load generation (roadmap S6).
//
// One Node process is a throughput CEILING, not a measurement. Above a few
// hundred ops/sec a single event loop spends its time on HTTP and JSON rather
// than on driving the ledger, and every number it reports is really a number
// about the load generator. Tier-1 capacity work needs several coordinated
// workers, which introduces two problems this module exists to solve.
//
// **Merging results correctly.** You cannot combine percentiles. The p99 of a
// pooled population is NOT the mean (or the max) of the workers' p99s — those
// are order statistics of different samples. The only correct merge is to pool
// the raw per-operation samples and recompute. Getting this wrong is the same
// class of error as coordinated omission (S3): the tool still prints a
// confident number, and the number is fiction. So workers ship raw samples and
// merging happens exactly once, here.
//
// **Measuring the same window.** Workers start with some skew, so the merged
// wall clock is the UNION window (earliest start → latest end), not any single
// worker's elapsed time and certainly not the sum. Using a sum would divide
// throughput by the worker count; using one worker's window would inflate it.

import { LatencyHistogram, type HistogramJson } from "./histogram.ts";
import { instrument, type LagSample, type TrafficEstimate } from "./instrument.ts";
import type { LoadModel, LoadReport, PreparedState } from "./load.ts";
import { summarize, type OpResult } from "./metrics.ts";
import type { Workload } from "./workload.ts";

/** What a coordinator hands a worker. Deliberately plain JSON: the built-in
 * runner forks local processes, but the same job could be shipped to another
 * machine without changing the worker. */
export interface WorkerJob {
  workerIndex: number;
  /** Ledger endpoint this worker drives (also its label in reports). */
  api: string;
  /** [S6] The whole network, when the workload places parties across several
   * participants. A worker must then be a client of every node, because the
   * party it has to submit for may be hosted anywhere. Absent → just `api`. */
  apis?: string[];
  workload: Workload;
  /** This worker's SHARE of the load (ops, and rate or concurrency). */
  model: LoadModel;
  /** App state the coordinator already built — setup runs once, not per worker. */
  state: PreparedState;
  runId: string;
  seed: number;
  amount: string;
  lagSampleMs?: number;
  noTraffic?: boolean;
  /** Cap on per-operation samples returned. The histogram covers every
   * operation regardless; samples only drive attribution. */
  maxSamples?: number;
}

/** What a worker sends back: raw material, not conclusions.
 *
 * At institutional volume `results` is deliberately CAPPED — ten million
 * samples per worker is gigabytes through IPC — so two things travel beside
 * it: exact outcome counts, and a latency HISTOGRAM. Histograms merge exactly,
 * so pooled percentiles stay correct without pooled samples. */
export interface WorkerResult {
  workerIndex: number;
  api: string;
  /** Per-operation samples, possibly a bounded subset (see `counts`). */
  results: OpResult[];
  /** Exact outcome totals, even when `results` was capped. */
  counts?: { ops: number; committed: number; contention: number; rejected: number };
  /** Full latency distribution in bounded memory. */
  histogram?: HistogramJson;
  lagSamples: LagSample[];
  trafficEstimates: TrafficEstimate[];
  startedAtEpochMs: number;
  endedAtEpochMs: number;
  /** Set when the worker failed outright rather than measuring. */
  error?: string;
}

export interface ClusterReport extends LoadReport {
  cluster: {
    workers: number;
    endpoints: string[];
    /** Union window across all workers, in ms. */
    wallMs: number;
    /** Start-time skew between the earliest and latest worker. */
    startSkewMs: number;
    perWorker: Array<{
      workerIndex: number;
      api: string;
      ops: number;
      committed: number;
      throughputPerSec: number;
      p99: number;
      error?: string;
    }>;
    /** Per-endpoint totals — meaningful once workers target several participants. */
    perEndpoint: Array<{ api: string; ops: number; committed: number; throughputPerSec: number }>;
  };
}

/** Split a total load level across N workers, giving the remainder to the
 * first workers so the parts always sum to the requested total. */
export function splitEvenly(total: number, workers: number): number[] {
  if (workers < 1) throw new Error("need at least one worker");
  const base = Math.floor(total / workers);
  const extra = total - base * workers;
  return Array.from({ length: workers }, (_, i) => base + (i < extra ? 1 : 0));
}

/** Divide a model into per-worker shares. Ops and the load dimension both
 * split: N workers at rate R/N each produce an aggregate arrival rate of R,
 * which is what the user asked for. */
export function splitModel(model: LoadModel, workers: number): LoadModel[] {
  const ops = splitEvenly(model.ops, workers);
  const warmup = splitEvenly(model.warmup, workers);
  if (model.kind === "open") {
    const rate = model.rate ?? 100;
    const maxInFlight = model.maxInFlight;
    return Array.from({ length: workers }, (_, i) => ({
      kind: "open" as const,
      ops: ops[i],
      warmup: warmup[i],
      // Rate is a real number, so it divides cleanly — no remainder games.
      rate: rate / workers,
      maxInFlight: maxInFlight === undefined ? undefined : Math.max(1, Math.ceil(maxInFlight / workers)),
    }));
  }
  const conc = splitEvenly(model.concurrency ?? 16, workers);
  return Array.from({ length: workers }, (_, i) => ({
    kind: "closed" as const,
    ops: ops[i],
    warmup: warmup[i],
    // A worker with no concurrency slots would never run: floor at 1.
    concurrency: Math.max(1, conc[i]),
  }));
}

/** Assign workers to endpoints round-robin, so W workers spread over E
 * participants as evenly as the counts allow. */
export function assignEndpoints(endpoints: string[], workers: number): string[] {
  if (endpoints.length === 0) throw new Error("need at least one endpoint");
  return Array.from({ length: workers }, (_, i) => endpoints[i % endpoints.length]);
}

/** Merge worker results into one report over the pooled samples. */
export function mergeResults(
  parts: WorkerResult[],
  model: LoadModel,
  workload: Workload,
  synchronizerId?: string,
): ClusterReport {
  const ok = parts.filter((p) => !p.error);
  const results = ok.flatMap((p) => p.results);

  // The union window: earliest start to latest end. Not a sum (that would
  // divide throughput by the worker count) and not one worker's window.
  const starts = ok.map((p) => p.startedAtEpochMs);
  const ends = ok.map((p) => p.endedAtEpochMs);
  const wallMs = ok.length > 0 ? Math.max(...ends) - Math.min(...starts) : 0;
  const startSkewMs = ok.length > 0 ? Math.max(...starts) - Math.min(...starts) : 0;

  // Percentiles are recomputed over the POOLED data — never averaged.
  const summary = summarize(results, wallMs);

  // When workers shipped histograms, they describe EVERY operation, while
  // `results` may be a capped subset. Merging histograms is exact, so the
  // pooled distribution is the true one; prefer it over the sample's.
  const hists = ok.filter((p) => p.histogram).map((p) => LatencyHistogram.fromJSON(p.histogram!));
  if (hists.length > 0) {
    const merged = new LatencyHistogram();
    for (const h of hists) merged.merge(h);
    if (merged.count > 0) {
      summary.latency = {
        p50: merged.percentile(50),
        p90: merged.percentile(90),
        p95: merged.percentile(95),
        p99: merged.percentile(99),
        max: merged.maxMs,
        mean: merged.meanMs,
      };
      summary.latencyCurve = [50, 75, 90, 95, 99, 99.9].map((p) => ({ p, ms: merged.percentile(p) }));
    }
  }

  // Exact totals, even where samples were capped: throughput must never be a
  // function of how many samples happened to be retained.
  const totals = ok.reduce(
    (acc, p) => {
      const c = p.counts;
      if (!c) return acc;
      acc.seen = true;
      acc.ops += c.ops;
      acc.committed += c.committed;
      acc.contention += c.contention;
      acc.rejected += c.rejected;
      return acc;
    },
    { seen: false, ops: 0, committed: 0, contention: 0, rejected: 0 },
  );
  if (totals.seen) {
    summary.ops = totals.ops;
    summary.committed = totals.committed;
    summary.contention = totals.contention;
    summary.rejected = totals.rejected;
    const secs = wallMs / 1000;
    summary.throughputPerSec = secs > 0 ? totals.committed / secs : 0;
    summary.attemptedPerSec = secs > 0 ? totals.ops / secs : 0;
    summary.contentionRate = totals.ops > 0 ? totals.contention / totals.ops : 0;
  }

  const perWorker = parts.map((p) => {
    const s = summarize(p.results, Math.max(1, p.endedAtEpochMs - p.startedAtEpochMs));
    return {
      workerIndex: p.workerIndex,
      api: p.api,
      ops: p.results.length,
      committed: s.committed,
      throughputPerSec: s.throughputPerSec,
      p99: s.latency.p99,
      error: p.error,
    };
  });

  const endpoints = [...new Set(parts.map((p) => p.api))];
  const perEndpoint = endpoints.map((api) => {
    const rs = ok.filter((p) => p.api === api).flatMap((p) => p.results);
    const s = summarize(rs, wallMs);
    return { api, ops: rs.length, committed: s.committed, throughputPerSec: s.throughputPerSec };
  });

  return {
    model: model.kind,
    parties: workload.parties,
    ops: results.length,
    targetRatePerSec: model.kind === "open" ? model.rate : undefined,
    achievedRatePerSec: wallMs > 0 ? results.length / (wallMs / 1000) : 0,
    summary,
    instrumentation: instrument({
      results,
      wallMs,
      lagSamples: ok.flatMap((p) => p.lagSamples),
      // Cost per operation is a property of the command, not of the worker
      // that sent it, so one worker's estimates describe the whole run.
      trafficEstimates: ok.find((p) => p.trafficEstimates.length > 0)?.trafficEstimates ?? [],
      synchronizerId,
    }),
    cluster: {
      workers: parts.length,
      endpoints,
      wallMs,
      startSkewMs,
      perWorker,
      perEndpoint,
    },
  };
}

// ---- the coordinator -------------------------------------------------------

/** Fork the workers, hold them at the line until all are ready, then start
 * them together and collect raw samples.
 *
 * The ready/go handshake is not ceremony: without it, workers begin whenever
 * they finish connecting, so an open-model run spreads its aggregate arrival
 * rate over a wider window and silently under-delivers the requested rate. */
export async function runWorkers(
  jobs: WorkerJob[],
  o: { onEvent?: (msg: string) => void; timeoutMs?: number; workerCmd?: string } = {},
): Promise<WorkerResult[]> {
  // A command means the workers are not necessarily on this machine.
  if (o.workerCmd) return runWorkersVia(jobs, o.workerCmd, o);
  const { fork } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const workerPath = fileURLToPath(new URL("./worker.ts", import.meta.url));

  const children = jobs.map((job) => {
    const child = fork(workerPath, [], {
      env: { ...process.env, CANTON_STRESS_WORKER: "1" },
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    return { job, child };
  });

  const results = new Map<number, WorkerResult>();
  const failed = (job: WorkerJob, error: string): WorkerResult => ({
    workerIndex: job.workerIndex,
    api: job.api,
    results: [],
    lagSamples: [],
    trafficEstimates: [],
    startedAtEpochMs: Date.now(),
    endedAtEpochMs: Date.now(),
    error,
  });

  try {
    // Phase 1 — hand out the work and wait for every worker to report ready.
    await Promise.all(
      children.map(
        ({ job, child }) =>
          new Promise<void>((resolve) => {
            const onMsg = (m: { ready?: boolean; result?: WorkerResult }) => {
              if (m.ready) {
                child.off("message", onMsg);
                resolve();
              } else if (m.result) {
                results.set(job.workerIndex, m.result);
                child.off("message", onMsg);
                resolve();
              }
            };
            child.on("message", onMsg);
            child.once("error", (e) => {
              results.set(job.workerIndex, failed(job, String(e)));
              resolve();
            });
            child.once("exit", (code) => {
              if (!results.has(job.workerIndex))
                results.set(job.workerIndex, failed(job, `worker exited early (code ${code})`));
              resolve();
            });
            child.send({ job });
          }),
      ),
    );
    o.onEvent?.(`all ${children.length} workers ready — starting together`);

    // Phase 2 — go, then collect.
    const collect = children.map(
      ({ job, child }) =>
        new Promise<void>((resolve) => {
          if (results.has(job.workerIndex)) return resolve(); // already failed
          child.on("message", (m: { result?: WorkerResult }) => {
            if (m.result) {
              results.set(job.workerIndex, m.result);
              resolve();
            }
          });
          child.once("exit", (code) => {
            if (!results.has(job.workerIndex))
              results.set(job.workerIndex, failed(job, `worker exited without a result (code ${code})`));
            resolve();
          });
          child.send({ go: true });
        }),
    );

    const timeoutMs = o.timeoutMs ?? 30 * 60_000;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    });
    await Promise.race([Promise.all(collect), timeout]);
    if (timer) clearTimeout(timer);

    for (const { job } of children)
      if (!results.has(job.workerIndex))
        results.set(job.workerIndex, failed(job, `no result within ${timeoutMs}ms`));
  } finally {
    for (const { child } of children) if (child.connected || child.exitCode === null) child.kill();
  }

  return jobs.map((j) => results.get(j.workerIndex)!);
}

/** Run workers as an ARBITRARY COMMAND speaking line-delimited JSON on stdio.
 *
 * This is what makes the workers location-independent: the coordinator does not
 * fork them, it runs a command and talks over pipes. Any transport that can do
 * that works unchanged —
 *
 *   --worker-cmd "node src/cli.ts worker"                  (local subprocess)
 *   --worker-cmd "ssh perf-box canton-stress worker"       (another machine)
 *   --worker-cmd "kubectl run -i --rm w --image=… -- worker"
 *
 * The ready/go barrier is preserved, so workers spread across hosts still open
 * their measured windows together. */
export async function runWorkersVia(
  jobs: WorkerJob[],
  command: string,
  o: { onEvent?: (msg: string) => void; timeoutMs?: number } = {},
): Promise<WorkerResult[]> {
  const { spawn } = await import("node:child_process");

  const failed = (job: WorkerJob, error: string): WorkerResult => ({
    workerIndex: job.workerIndex,
    api: job.api,
    results: [],
    lagSamples: [],
    trafficEstimates: [],
    startedAtEpochMs: Date.now(),
    endedAtEpochMs: Date.now(),
    error,
  });

  const children = jobs.map((job) => {
    // `shell: true` so the command can be a full invocation with arguments —
    // an ssh line, a kubectl line, anything the operator can type.
    const child = spawn(command, { shell: true, stdio: ["pipe", "pipe", "inherit"] });
    const state = { ready: false, result: undefined as WorkerResult | undefined, buf: "" };
    child.stdout.setEncoding("utf8");
    return { job, child, state };
  });

  const onReady: Array<() => void> = [];
  const onResult: Array<() => void> = [];
  const readyPromises = children.map((c, i) => new Promise<void>((r) => (onReady[i] = r)));
  const resultPromises = children.map((c, i) => new Promise<void>((r) => (onResult[i] = r)));

  children.forEach(({ job, child, state }, i) => {
    child.stdout.on("data", (chunk: string) => {
      state.buf += chunk;
      let nl: number;
      while ((nl = state.buf.indexOf("\n")) >= 0) {
        const line = state.buf.slice(0, nl).trim();
        state.buf = state.buf.slice(nl + 1);
        if (!line) continue;
        let msg: { ready?: boolean; result?: WorkerResult; error?: string };
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // ignore anything that is not our protocol
        }
        if (msg.ready && !state.ready) {
          state.ready = true;
          onReady[i]();
        } else if (msg.result) {
          state.result = msg.result;
          onResult[i]();
        } else if (msg.error) {
          state.result = failed(job, msg.error);
          onReady[i]();
          onResult[i]();
        }
      }
    });
    child.once("error", (e) => {
      state.result = failed(job, `worker command failed: ${String(e)}`);
      onReady[i]();
      onResult[i]();
    });
    child.once("exit", (code) => {
      if (!state.result) {
        state.result = failed(job, `worker command exited (code ${code}) without a result`);
        onReady[i]();
        onResult[i]();
      }
    });
    child.stdin.write(JSON.stringify({ job }) + "\n");
  });

  const timeoutMs = o.timeoutMs ?? 30 * 60_000;
  const deadline = new Promise<void>((r) => setTimeout(r, timeoutMs).unref?.());

  await Promise.race([Promise.all(readyPromises), deadline]);
  o.onEvent?.(`all ${children.length} workers ready — starting together`);
  for (const { child, state } of children) if (!state.result) child.stdin.write(JSON.stringify({ go: true }) + "\n");

  await Promise.race([Promise.all(resultPromises), deadline]);
  for (const { child } of children) if (child.exitCode === null) child.kill();

  return children.map(({ job, state }) => state.result ?? failed(job, "no result before the deadline"));
}

/** Human-readable cluster block for the console. */
export function formatCluster(c: ClusterReport["cluster"]): string {
  const r1 = (n: number) => Math.round(n * 10) / 10;
  const out = [
    `  workers: ${c.workers} over ${c.endpoints.length} endpoint(s), ` +
      `union window ${r1(c.wallMs / 1000)}s, start skew ${r1(c.startSkewMs)}ms`,
  ];
  for (const w of c.perWorker)
    out.push(
      w.error
        ? `    worker ${w.workerIndex} (${w.api}): FAILED — ${w.error}`
        : `    worker ${w.workerIndex} (${w.api}): ${w.ops} ops, ` +
          `${r1(w.throughputPerSec)}/s, p99 ${r1(w.p99)}ms`,
    );
  if (c.perEndpoint.length > 1) {
    out.push("  per endpoint:");
    for (const e of c.perEndpoint)
      out.push(`    ${e.api}: ${e.ops} ops, ${r1(e.throughputPerSec)}/s committed`);
  }
  return out.join("\n");
}
