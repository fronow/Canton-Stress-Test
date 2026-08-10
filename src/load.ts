// The load runner: allocate parties, run a workload's setup, then drive its
// operation mix through the scheduler (closed or open model). One code path
// for both the declarative workloads (S1) and the create/transfer presets.

import { LatencyHistogram, type HistogramJson } from "./histogram.ts";
import { instrument, type Instrumentation, type LagSample, type TrafficEstimate } from "./instrument.ts";
import type { ActiveContract, DisclosedContract, LedgerApi } from "./ledger.ts";
import { summarize, type OpResult, type Summary } from "./metrics.ts";
import { runClosed, runOpen, type Task } from "./schedule.ts";
import { analyseMode, rateSchedule, type ModeReport, type ModeSpec } from "./modes.ts";
import { runSetup, type Bindings } from "./setup.ts";
import {
  buildCommand,
  pickOp,
  submittersFor,
  toSetupSteps,
  type BuildCtx,
  type ExerciseOp,
  type OpSpec,
  type PayloadCtx,
  type Workload,
} from "./workload.ts";

// Re-exported so callers/tests have one import site for payload substitution.
export { resolvePayload } from "./workload.ts";

export interface LoadModel {
  kind: "closed" | "open";
  /** Measured operations. */
  ops: number;
  /** Operations executed but discarded before measurement (system warm-up). */
  warmup: number;
  /** closed: fixed workers in flight. */
  concurrency?: number;
  /** open: target arrival rate (ops/sec). */
  rate?: number;
  /** open: max in-flight cap for backpressure (default = 4× rate or 256). */
  maxInFlight?: number;
  /** [S5] Run for a time rather than an operation count. When set, `ops` acts
   * only as a safety cap. */
  durationMs?: number;
  /** [S5] Discard the first N ms of the window instead of the first N ops. */
  warmupMs?: number;
  /** [S5] A test mode (ramp/soak/spike/stress) driving the arrival rate. */
  modeSpec?: ModeSpec;
}

export interface LoadReport {
  model: "closed" | "open";
  parties: number;
  ops: number;
  targetRatePerSec?: number;
  achievedRatePerSec?: number;
  summary: Summary;
  /** [S2] What the setup phase built, so a report says which state the numbers
   * were measured against. */
  setup?: { steps: number; submitted: number; bindings: Record<string, number> };
  /** [S4] Canton-specific instrumentation: hot contracts, per-party latency,
   * read-side lag, traffic cost. */
  instrumentation?: Instrumentation;
  /** [S5] Time-series behaviour and the mode's verdict (knee/cliff, drift,
   * recovery, breaking point). */
  modeReport?: ModeReport;
}

export interface RunOptions {
  amount: string;
  seed: number;
  runId: string;
  onProgress?: (done: number, total: number) => void;
  onSetupStep?: (step: number, label: string, bound: number) => void;
  /** Called once every party exists, BEFORE setup submits anything. A token
   * can only grant rights over parties that exist, and party ids are not known
   * until they are allocated — so this is where an auth provider widens its
   * claims. */
  onPartiesAllocated?: (parties: string[]) => void | Promise<void>;
  /** [scale] Repetitions of a setup step to run concurrently. Setup is not
   * measured, so serialising it buys nothing and costs hours at scale. */
  setupConcurrency?: number;
  /** [S4] Sample read-side lag every N ms during the measured window. 0/undefined
   * disables it. The sampler is a single lightweight poll, deliberately off the
   * submission path so it cannot distort the latency it is measuring. */
  lagSampleMs?: number;
  /** [S4] Skip the pre-run traffic cost estimation. */
  noTraffic?: boolean;
  /** [S6] Awaited immediately BEFORE the measured window opens — after the ACS
   * snapshot and cost estimation are already done. A distributed worker uses
   * it as a start barrier, so "go" starts measuring rather than starting a
   * variable amount of preparation. */
  beforeStart?: () => Promise<void>;
  /** [scale] Cap on per-operation samples RETAINED in memory. The histogram
   * and counters see every operation regardless; samples only drive
   * attribution. Default 20k. */
  maxRetainedSamples?: number;
}

// mulberry32 — deterministic RNG so the workload SHAPE (which op, which party,
// which target) is reproducible for a seed. (Timing is never reproducible.)
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEFAULT_CREATE_ARGS = { issuer: "$issuer", owner: "$party", amount: "$amount" };

/** Build a summary from aggregates rather than samples, for runs whose sample
 * retention was capped. Totals come from exact counters and the distribution
 * from the histogram, so nothing depends on how many samples were kept. */
function summaryFromAggregates(
  counts: { ops: number; committed: number; contention: number; rejected: number },
  hist: LatencyHistogram,
  wallMs: number,
): Summary {
  const secs = wallMs / 1000;
  return {
    ops: counts.ops,
    committed: counts.committed,
    contention: counts.contention,
    rejected: counts.rejected,
    wallMs,
    throughputPerSec: secs > 0 ? counts.committed / secs : 0,
    attemptedPerSec: secs > 0 ? counts.ops / secs : 0,
    contentionRate: counts.ops > 0 ? counts.contention / counts.ops : 0,
    latency: {
      p50: hist.percentile(50),
      p90: hist.percentile(90),
      p95: hist.percentile(95),
      p99: hist.percentile(99),
      max: hist.maxMs,
      mean: hist.meanMs,
    },
    latencyCurve: [50, 75, 90, 95, 99, 99.9].map((p) => ({ p, ms: hist.percentile(p) })),
  };
}

/** Everything the measured window needs, once the app has been driven into a
 * loadable state: the party population, the named roles, and the contract ids
 * setup bound. */
export interface PreparedRun {
  parties: string[];
  roles: Record<string, string>;
  bindings: Bindings;
  payloadCtx: PayloadCtx;
  rng: () => number;
  setup: { steps: number; submitted: number; bindings: Record<string, number> };
  /** [S6] party → participant index. */
  hostOf: Record<string, number>;
  /** Contracts captured for explicit disclosure. */
  disclosures: DisclosedContract[];
}

/** [S6] The serializable part of a prepared run — everything a load-generating
 * worker needs, and nothing that cannot cross a process boundary. Setup runs
 * ONCE on the coordinator; every worker then measures against the same app
 * state instead of each building its own. */
export interface PreparedState {
  parties: string[];
  roles: Record<string, string>;
  bindings: Bindings;
  /** Contracts to attach to every measured submission (explicit disclosure). */
  disclosures?: DisclosedContract[];
  /** [S6] Which participant (index into the endpoint list) hosts each party.
   * Absent, or all-zero, for a single-participant run. */
  hostOf?: Record<string, number>;
}

/** [S6] The participants a run drives. A single-node run is the one-element
 * case, so there is one code path rather than two. */
export type Network = LedgerApi | LedgerApi[];

const asList = (n: Network): LedgerApi[] => (Array.isArray(n) ? n : [n]);

export const preparedState = (p: PreparedRun): PreparedState => ({
  parties: p.parties,
  roles: p.roles,
  bindings: p.bindings,
  hostOf: p.hostOf,
  disclosures: p.disclosures,
});

/** Allocate parties and roles, then run the setup program (S2). Exposed on its
 * own so `--setup-only` can drive an app into state without a load run. */
export async function prepareRun(
  network: Network,
  workload: Workload,
  o: RunOptions,
): Promise<PreparedRun> {
  const apis = asList(network);
  // [S6] A party is HOSTED by a participant — it is not a network-wide name
  // that any node can act for. Placement therefore decides which node can sign
  // what, which is the whole substance of multi-participant load.
  const roundRobin = workload.placement === "round-robin" && apis.length > 1;
  const hostOf: Record<string, number> = {};

  const parties: string[] = [];
  for (let i = 0; i < workload.parties; i++) {
    const host = roundRobin ? i % apis.length : 0;
    const p = await apis[host].allocateParty(`cs-${o.runId}-p${i}`);
    parties.push(p);
    hostOf[p] = host;
  }
  // Roles are allocated ALONGSIDE the population, not carved out of it, so a
  // custodian never doubles as a random load-bearing counterparty. They are
  // usually infrastructure actors pinned to one node.
  const roles: Record<string, string> = {};
  for (const name of workload.roles ?? []) {
    const host = Math.min(apis.length - 1, Math.max(0, workload.rolePlacement?.[name] ?? 0));
    const p = await apis[host].allocateParty(`cs-${o.runId}-${name}`);
    roles[name] = p;
    hostOf[p] = host;
  }

  const rng = mulberry32(o.seed);
  const party = () => parties[Math.floor(rng() * parties.length)];
  const payloadCtx: PayloadCtx = {
    issuer: parties[0],
    party,
    parties,
    amount: o.amount,
    roles,
    rand: rng,
  };

  // Awaited: setup submits immediately after, and rights granted a moment too
  // late are rights that were not there when they were needed.
  await o.onPartiesAllocated?.([...parties, ...Object.values(roles)]);

  const steps = toSetupSteps(workload.setup);
  // Route each step to the node hosting its submitters.
  const apiFor = (actAs: string[]): LedgerApi => apis[hostOf[actAs[0]] ?? 0];
  const { bindings, submitted, disclosures } = await runSetup(apiFor, steps, payloadCtx, {
    runId: o.runId,
    rand: rng,
    defaultActAs: [parties[0]],
    onStep: o.onSetupStep,
    concurrency: o.setupConcurrency,
  });

  return {
    parties,
    roles,
    bindings,
    payloadCtx: { ...payloadCtx, bindings },
    rng,
    hostOf,
    disclosures,
    setup: {
      steps: steps.length,
      submitted,
      bindings: Object.fromEntries(Object.entries(bindings).map(([k, v]) => [k, v.length])),
    },
  };
}

/** Run a declarative workload end to end: setup, then measure. */
export async function runWorkload(
  network: Network,
  workload: Workload,
  model: LoadModel,
  o: RunOptions,
): Promise<LoadReport> {
  const prep = await prepareRun(network, workload, o);
  const run = await runMeasured(network, workload, model, preparedState(prep), o);
  return { ...run.report, setup: prep.setup.steps > 0 ? prep.setup : undefined };
}

/** [S6] A measured window plus the RAW material behind it. Merging several
 * workers requires the raw per-operation samples: percentiles cannot be
 * combined from summaries, they have to be recomputed over the pooled data. */
export interface MeasuredRun {
  report: LoadReport;
  results: OpResult[];
  /** Full latency distribution in bounded memory — merges exactly across
   * workers, so pooled percentiles survive capping `results`. */
  histogram: HistogramJson;
  /** Exact outcome totals, independent of how many samples were retained. */
  counts: { ops: number; committed: number; contention: number; rejected: number };
  lagSamples: LagSample[];
  trafficEstimates: TrafficEstimate[];
  /** Wall-clock bounds, so a coordinator can compute the true union window. */
  startedAtEpochMs: number;
  endedAtEpochMs: number;
}

/** [S6] The measured window on its own, against app state that was prepared
 * elsewhere. This is what a distributed worker runs: no party allocation, no
 * setup — just load against state the coordinator already built. */
export async function runMeasured(
  network: Network,
  workload: Workload,
  model: LoadModel,
  state: PreparedState,
  o: RunOptions,
): Promise<MeasuredRun> {
  const apis = asList(network);
  const { parties, roles, bindings } = state;
  const hostOf = state.hostOf ?? {};
  const rng = mulberry32(o.seed);

  // [S6] One context PER PARTICIPANT. A party is hosted by exactly one node,
  // and Canton refuses a submission for a party the receiving participant does
  // not host — so the party population an operation may draw from, and the
  // contracts it may target, are both participant-local. With a single
  // participant this collapses to exactly the previous behaviour.
  const hostIndex = (p: string): number => hostOf[p] ?? 0;
  const local = apis.map((_, idx) => ({
    idx,
    parties: parties.filter((p) => hostIndex(p) === idx),
    roles: Object.fromEntries(Object.entries(roles).filter(([, p]) => hostIndex(p) === idx)),
  }));
  // Only nodes that actually host load-bearing parties can drive operations.
  const active = local.filter((l) => l.parties.length > 0 || Object.keys(l.roles).length > 0);
  if (active.length === 0) throw new Error("no participant hosts any party");

  // Every contract id setup bound — so contract ids appearing inside choice
  // arguments can be recognised without re-scanning per operation.
  const boundCids = new Set<string>(Object.values(bindings).flat());

  const exerciseOps = workload.operations
    .map((w) => w.op)
    .filter((op): op is ExerciseOp => op.kind === "exercise")
    // An op that names its own target ("contract": "$ref:factory") needs no
    // live-contract pool, so do not read one — reading it is wasted work, and
    // for a target addressed through an INTERFACE id the template-filtered
    // query is not even valid.
    .filter((op) => op.contract === undefined);

  // Pre-fetch a snapshot of the live contracts every exercise op targets, on
  // each participant, read as the parties IT hosts — a participant only sees
  // its own parties' projections.
  // (One snapshot up front; picks may go stale mid-run → contention, which is
  // real and classified as such.) Payloads come along because an op may need
  // the target's own fields — who owns it, what it references.
  interface ParticipantCtx {
    api: LedgerApi;
    readers: string[];
    buildCtx: BuildCtx;
    fallbackFor: (op: OpSpec) => string[];
  }
  const ctxs: ParticipantCtx[] = [];
  for (const l of active) {
    const api = apis[l.idx];
    const readers = [...l.parties, ...Object.values(l.roles)];
    const pools = new Map<string, ActiveContract[]>();
    for (const op of exerciseOps) {
      const t = op.targetTemplate ?? op.template;
      if (pools.has(t)) continue;
      pools.set(t, await api.activeContracts(readers, t, op.targetKind ?? "template"));
    }
    const pool = l.parties.length > 0 ? l.parties : readers;
    const payloadCtx: PayloadCtx = {
      issuer: pool[0],
      party: () => pool[Math.floor(rng() * pool.length)],
      parties: pool,
      amount: o.amount,
      // Roles stay globally visible for payload substitution — an argument may
      // legitimately name a party this node does not host. Only SUBMITTERS are
      // constrained.
      roles,
      bindings,
      rand: rng,
    };
    ctxs.push({
      api,
      readers,
      buildCtx: {
        ...payloadCtx,
        rand: rng,
        contractsFor: (t: string) => pools.get(t) ?? [],
        boundCids,
      } as BuildCtx,
      // Default submitters, when an op does not say: creates are signed by the
      // issuer, exercises by everyone this node hosts (the pre-S2 behaviour,
      // narrowed to what the node can actually sign for).
      fallbackFor: (op: OpSpec): string[] => (op.kind === "create" ? [pool[0]] : readers),
    });
  }
  const prep = { parties, roles, payloadCtx: ctxs[0].buildCtx };
  const buildCtx = ctxs[0].buildCtx;
  const fallbackFor = ctxs[0].fallbackFor;

  const total = model.ops + model.warmup;
  const task: Task = async (i) => {
    // Rotate across participants so load is spread over the network rather
    // than concentrated on one node.
    const c = ctxs[i % ctxs.length];
    const picked = pickOp(workload.operations, rng());
    const built = buildCommand(picked.op, c.buildCtx);
    if (!built) return { ok: false, error: "no live target contract for exercise op" };
    const { actAs, readAs } = submittersFor(
      picked.op,
      picked.submit,
      built.target,
      c.buildCtx,
      c.fallbackFor(picked.op),
    );
    // [S6] Route by the SUBMITTER, not by the rotation. Which party must sign
    // is often decided by the contract (`actAsFrom` reads it off the target),
    // and only the participant hosting that party may submit for it. Sending
    // to the rotated node instead rejected every operation whose counterparty
    // lived elsewhere — half of a two-node cross-participant run.
    const submitApi = actAs.length > 0 ? apis[hostIndex(actAs[0])] ?? c.api : c.api;
    const res = await submitApi.submitAndWait({
      commands: [built.command],
      commandId: `cs-${o.runId}-op-${i}`,
      actAs,
      readAs,
      // Captured once during setup; a wallet attaches these to every call.
      disclosedContracts: state.disclosures,
    });
    o.onProgress?.(i + 1, total);
    return {
      ok: res.ok,
      error: res.ok ? undefined : res.error,
      // [S4] What this op touched, so contention can be traced to a contract.
      attribution: {
        template: picked.op.template,
        choice: picked.op.kind === "exercise" ? picked.op.choice : undefined,
        contractId: built.target?.contractId,
        argumentContractIds: built.argumentContractIds,
        parties: actAs,
      },
    };
  };

  // [S4] Cost is estimated BEFORE the measured window: one prepare call per
  // distinct operation, so instrumentation never perturbs the numbers.
  const synchronizerId = await ctxs[0].api.connectedSynchronizerId?.().catch(() => undefined);
  const trafficEstimates = o.noTraffic
    ? []
    : await estimateTraffic(ctxs[0].api, workload, buildCtx, fallbackFor, synchronizerId);

  // Everything above this line is preparation — snapshots, cost estimation,
  // connection warm-up. The barrier sits HERE so that when a coordinator says
  // "go", every worker begins measuring, not preparing.
  await o.beforeStart?.();

  const lag = startLagSampler(ctxs[0].api, o.lagSampleMs ?? 0);

  let results: OpResult[];
  let wallMs: number;
  let achievedRatePerSec: number | undefined;
  // Aggregate as results arrive, so nothing has to be RETAINED to compute the
  // distribution. What is kept is bounded and exists only so hotspot and
  // per-party attribution have something to work with.
  const liveHist = new LatencyHistogram();
  const tally = { ops: 0, committed: 0, contention: 0, rejected: 0 };
  const onResult = (r: OpResult): void => {
    liveHist.record(r.latencyMs);
    tally.ops++;
    tally[r.outcome]++;
  };
  const maxRetained = o.maxRetainedSamples ?? 20_000;

  const startedAtEpochMs = Date.now();
  try {
    // A mode brings its own warm-up window unless the caller overrides it.
    const warmup = {
      count: model.warmup || undefined,
      ms: model.warmupMs ?? model.modeSpec?.warmupMs,
    };
    if (model.kind === "open") {
      const rate = model.rate ?? 100;
      // [S5] A mode supplies the arrival rate as a function of time; a plain
      // run is the constant case of the same thing.
      const schedule = model.modeSpec ? rateSchedule(model.modeSpec) : rate;
      // Size the in-flight cap off the PEAK offered rate, or a ramp would be
      // throttled by a cap chosen for its starting rate.
      const peak = model.modeSpec ? Math.max(model.modeSpec.fromRate, model.modeSpec.toRate) : rate;
      const maxInFlight = model.maxInFlight ?? Math.max(256, Math.ceil(peak * 4));
      const r = await runOpen({
        count: total > 0 ? total : undefined,
        durationMs: model.durationMs ?? model.modeSpec?.durationMs,
        warmup,
        ratePerSec: schedule,
        maxInFlight,
        task,
        onResult,
        maxRetained,
      });
      results = r.results;
      wallMs = r.wallMs;
      achievedRatePerSec = r.achievedRatePerSec;
    } else {
      const start = performance.now();
      results = await runClosed({
        count: total > 0 ? total : undefined,
        durationMs: model.durationMs ?? model.modeSpec?.durationMs,
        warmup,
        concurrency: model.concurrency ?? 16,
        task,
        onResult,
        maxRetained,
      });
      wallMs = performance.now() - start;
    }
  } finally {
    lag.stop();
  }

  // From the SINK, not from `results` — which is now a bounded subset kept
  // only for attribution. Every operation reached the histogram and the tally.
  const histogram = liveHist;
  const counts = { ...tally };

  // The summary must describe the whole run, so take the distribution from the
  // histogram and the totals from the tally whenever samples were truncated.
  const truncated = counts.ops > results.length;

  return {
    histogram: histogram.toJSON(),
    counts,
    report: {
      model: model.kind,
      parties: workload.parties,
      ops: results.length,
      // With a mode the arrival rate is a schedule, not a single target —
      // the mode report describes it, so reporting one number here would lie.
      targetRatePerSec: model.modeSpec ? undefined : model.kind === "open" ? model.rate : undefined,
      achievedRatePerSec,
      summary: truncated ? summaryFromAggregates(counts, histogram, wallMs) : summarize(results, wallMs),
      instrumentation: instrument({
        results,
        wallMs,
        lagSamples: lag.samples,
        trafficEstimates,
        synchronizerId,
      }),
      modeReport: model.modeSpec ? analyseMode(model.modeSpec, results) : undefined,
    },
    results,
    lagSamples: lag.samples,
    trafficEstimates,
    startedAtEpochMs,
    endedAtEpochMs: Date.now(),
  };
}

/** [S4] Poll the write path's high-water mark while the load runs, so we can
 * see the read side fall behind. Fire-and-forget: a failed sample is dropped
 * rather than allowed to disturb the run. */
function startLagSampler(
  api: LedgerApi,
  everyMs: number,
): { samples: LagSample[]; stop: () => void } {
  const samples: LagSample[] = [];
  if (everyMs <= 0 || !api.ledgerEnd) return { samples, stop: () => {} };
  const t0 = performance.now();
  let peak = 0;
  const timer = setInterval(() => {
    const started = performance.now();
    api
      .ledgerEnd!()
      .then((offset) => {
        // The read path's own view of the end, against the furthest point we
        // have ever seen: how many offsets it is trailing right now.
        peak = Math.max(peak, offset);
        samples.push({
          atMs: started - t0,
          offsetLag: peak - offset,
          queryMs: performance.now() - started,
        });
      })
      .catch(() => {});
  }, everyMs);
  timer.unref?.();
  return { samples, stop: () => clearInterval(timer) };
}

/** [S4] One CIP-0104 cost estimate per distinct operation in the mix. */
async function estimateTraffic(
  api: LedgerApi,
  workload: Workload,
  buildCtx: BuildCtx,
  fallbackFor: (op: OpSpec) => string[],
  synchronizerId: string | undefined,
): Promise<TrafficEstimate[]> {
  if (!api.estimateTrafficCost || !synchronizerId) return [];
  const out: TrafficEstimate[] = [];
  const seen = new Set<string>();
  for (const w of workload.operations) {
    const key = `${shortTemplate(w.op.template)}:${w.op.kind === "exercise" ? w.op.choice : "create"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const built = buildCommand(w.op, buildCtx);
    if (!built) continue;
    const { actAs } = submittersFor(w.op, w.submit, built.target, buildCtx, fallbackFor(w.op));
    const cost = await api.estimateTrafficCost({ command: built.command, actAs, synchronizerId });
    if (cost)
      out.push({
        operation: key,
        confirmationRequest: cost.confirmationRequest,
        confirmationResponse: cost.confirmationResponse,
        total: cost.total,
      });
  }
  return out;
}

const shortTemplate = (t: string): string => {
  const parts = t.split(":");
  return parts.length >= 3 ? parts.slice(-2).join(":") : t;
};

// ---- presets: build a Workload for the two quick smoke workloads -----------

export interface PresetOptions {
  parties: number;
  ops: number;
  concurrency: number;
  workload: "create" | "transfer";
  templateId: string;
  transferChoice: string;
  transferNewOwnerField: string;
  amount: string;
  createArgs?: Record<string, unknown>;
  runId: string;
  seed: number;
  onProgress?: (done: number, total: number) => void;
}

/** Build a Workload for the two quick smoke presets (create / transfer). */
export function buildPresetWorkload(o: {
  workload: "create" | "transfer";
  templateId: string;
  parties: number;
  poolSize: number;
  transferChoice: string;
  transferNewOwnerField: string;
  createArgs?: Record<string, unknown>;
}): Workload {
  const createArgs = o.createArgs ?? DEFAULT_CREATE_ARGS;
  const createOp: OpSpec = { kind: "create", template: o.templateId, args: createArgs };
  if (o.workload === "create")
    return { parties: o.parties, setup: [], operations: [{ weight: 1, op: createOp }] };
  return {
    parties: o.parties,
    setup: Array.from({ length: o.poolSize }, () => createOp),
    operations: [
      {
        weight: 1,
        op: {
          kind: "exercise",
          template: o.templateId,
          choice: o.transferChoice,
          args: { [o.transferNewOwnerField]: "$party" },
        },
      },
    ],
  };
}

/** The MVP create/transfer presets, run through the same engine (closed model). */
export async function runLoad(api: LedgerApi, o: PresetOptions): Promise<LoadReport> {
  const workload = buildPresetWorkload({
    workload: o.workload,
    templateId: o.templateId,
    parties: o.parties,
    poolSize: Math.max(o.concurrency * 2, 8),
    transferChoice: o.transferChoice,
    transferNewOwnerField: o.transferNewOwnerField,
    createArgs: o.createArgs,
  });
  return runWorkload(api, workload, { kind: "closed", ops: o.ops, warmup: 0, concurrency: o.concurrency }, {
    amount: o.amount,
    seed: o.seed,
    runId: o.runId,
    onProgress: o.onProgress,
  });
}
