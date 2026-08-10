// A load-generating worker (roadmap S6).
//
// Runs ONE share of the measured window against one endpoint and ships raw
// per-operation samples back. It never allocates parties and never runs setup:
// the coordinator did that once, and every worker measures against the same
// app state. That is what makes the workers' samples poolable.
//
// The worker is a plain process that reads a job and writes a result, so the
// same code serves the built-in local fan-out today and a remote runner later
// (ssh, a container, a k8s Job) without changing.

import type { WorkerJob, WorkerResult } from "./cluster.ts";
import { LedgerClient } from "./ledger.ts";
import { runMeasured } from "./load.ts";

/** Run one job. Any failure is returned as data — a dead worker must not take
 * the whole run down, it just contributes nothing to the pooled samples.
 *
 * `beforeStart` is the start barrier: it is awaited once this worker has taken
 * its ACS snapshot and priced its operations, so releasing it starts the
 * measured window everywhere at once. */
export async function runWorkerJob(
  job: WorkerJob,
  beforeStart?: () => Promise<void>,
): Promise<WorkerResult> {
  const base: Pick<WorkerResult, "workerIndex" | "api"> = {
    workerIndex: job.workerIndex,
    api: job.api,
  };
  try {
    // A placement-aware workload needs the whole network; a plain one needs
    // only the endpoint this worker was assigned.
    const network =
      job.apis && job.apis.length > 1
        ? job.apis.map((u) => new LedgerClient(u))
        : new LedgerClient(job.api);
    const run = await runMeasured(network, job.workload, job.model, job.state, {
      amount: job.amount,
      // Each worker gets its own seed, so they explore different op/target
      // choices instead of all hammering the same contracts in lockstep.
      seed: job.seed + job.workerIndex * 7919,
      // The runId lands in every commandId. It MUST differ per worker: the
      // participant deduplicates on (userId, actAs, commandId), so a shared
      // id would make every worker after the first look like a retry.
      runId: job.runId,
      lagSampleMs: job.lagSampleMs,
      // One worker is enough to price the operations; the rest skip it.
      noTraffic: job.noTraffic,
      beforeStart,
    });
    // Cap the samples that cross the process boundary. The histogram already
    // describes every operation exactly, and the samples are only needed for
    // attribution (which contract, which party) — for which a large bounded
    // subset is ample. Ten million objects through IPC is not.
    // Samples exist only for ATTRIBUTION — which contract, which party. The
    // histogram already describes every operation exactly, so a bounded subset
    // is ample: 20k spread over a workload's contracts still ranks hotspots.
    // The earlier 200k default made a single worker's message tens of
    // megabytes, which is both slow and the thing that exposed the flush race
    // above.
    const cap = job.maxSamples ?? 20_000;
    return {
      ...base,
      results: run.results.length > cap ? run.results.slice(0, cap) : run.results,
      histogram: run.histogram,
      counts: run.counts,
      lagSamples: run.lagSamples,
      trafficEstimates: run.trafficEstimates,
      startedAtEpochMs: run.startedAtEpochMs,
      endedAtEpochMs: run.endedAtEpochMs,
    };
  } catch (e) {
    const now = Date.now();
    return {
      ...base,
      results: [],
      lagSamples: [],
      trafficEstimates: [],
      startedAtEpochMs: now,
      endedAtEpochMs: now,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ---- child-process entry point --------------------------------------------
//
// Forked by the coordinator. Protocol, deliberately tiny:
//   parent → child   { job }            the work
//   child  → parent  { ready: true }    SNAPSHOT TAKEN, at the start line
//   parent → child   { go: true }       start measuring (all workers together)
//   child  → parent  { result }         raw samples
//
// Note where `ready` is sent: the worker begins the job immediately and only
// reports ready once its preparation is finished. Signalling on receipt of the
// job instead would mean "go" kicks off a variable amount of ACS-snapshotting
// per worker — measured on a live sandbox as a full second of start skew
// across a 2.4s window. The barrier has to sit at the measured window's edge,
// or the workers are not measuring the same interval at all. That matters
// most in the open model, where skew spreads the aggregate arrival rate over
// a wider window and quietly under-delivers the requested rate.

// ---- stdio entry point (remote-capable) ------------------------------------
//
// The same protocol as the fork path, but over stdin/stdout as line-delimited
// JSON, so a worker can run anywhere a command can run and pipes can reach:
//
//   ssh host 'canton-stress worker'
//   kubectl run --stdin ... -- canton-stress worker
//   docker run -i … canton-stress worker
//
// The coordinator drives it with `--worker-cmd`. Nothing here knows or cares
// which of those it is — that is the point of keeping the job and the result
// plain JSON.

/** Read a stream as complete lines, ignoring blanks. */
async function* jsonLines(stream: NodeJS.ReadableStream): AsyncGenerator<Record<string, unknown>> {
  let buf = "";
  for await (const chunk of stream) {
    buf += String(chunk);
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield JSON.parse(line) as Record<string, unknown>;
    }
  }
}

/** `canton-stress worker` — one job in, one result out. */
export async function stdioWorkerMain(): Promise<void> {
  let release: () => void = () => {};
  const go = new Promise<void>((r) => {
    release = r;
  });
  let running: Promise<WorkerResult> | null = null;

  for await (const msg of jsonLines(process.stdin)) {
    if (msg.job && !running) {
      running = runWorkerJob(msg.job as WorkerJob, async () => {
        // Ready only once preparation is done — same barrier discipline as the
        // fork path, for the same reason (see the note above).
        process.stdout.write(JSON.stringify({ ready: true }) + "\n");
        await go;
      });
    } else if (msg.go) {
      release();
    }
    if (running && msg.go) break;
  }
  if (!running) {
    process.stdout.write(JSON.stringify({ error: "no job received on stdin" }) + "\n");
    return;
  }
  const result = await running;
  process.stdout.write(JSON.stringify({ result }) + "\n");
}

if (process.env.CANTON_STRESS_WORKER === "1") {
  process.on("message", (msg: { job?: WorkerJob; go?: boolean }) => {
    if (!msg.job) return;
    let release: () => void;
    const go = new Promise<void>((r) => {
      release = r;
    });
    process.on("message", (m: { go?: boolean }) => {
      if (m.go) release();
    });
    runWorkerJob(msg.job, async () => {
      process.send?.({ ready: true });
      await go;
    }).then((result) => {
      // `process.send` is ASYNCHRONOUS: exiting immediately after it races the
      // IPC flush. Small messages usually win that race; a large result does
      // not, and the coordinator then sees "exited early (code 0)" and drops
      // the worker's entire contribution. Measured at 200k operations: a third
      // of the run silently vanished. Exit only once the write has completed.
      process.send?.({ result }, (err?: Error | null) => {
        process.disconnect?.();
        process.exit(err ? 1 : 0);
      });
    });
  });
}
