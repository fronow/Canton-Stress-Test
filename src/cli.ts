#!/usr/bin/env node
// canton-stress — load / performance / stress testing for Canton apps.
//
//   canton-stress run [<dar>] --template <id>
//     [--workload create|transfer | --workload-file <json>]
//     [--model closed|open] [--concurrency n] [--rate ops/sec] [--max-in-flight n]
//     [--ops n] [--warmup n] [--parties n] [--amount d] [--seed n]
//     [--api <url>] [--sandbox] [--java-home <dir>]
//     [--transfer-choice <name>] [--new-owner-field <name>] [--create-args <json>]
//     [--report <file>]
//
// Load models:
//   closed  — keep --concurrency ops in flight (self-pacing). Good for "how
//             fast can it go?".
//   open    — arrivals at --rate ops/sec, with coordinated-omission-correct
//             latency. Good for "does it hold p99 at N ops/sec?" (SLA).

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename } from "node:path";
import {
  assignEndpoints,
  formatCluster,
  mergeResults,
  runWorkers,
  splitModel,
  type WorkerJob,
} from "./cluster.ts";
import {
  hs256Provider,
  noAuth,
  oauthClientCredentials,
  staticToken,
  tokenFromFile,
  type OAuthConfig,
  type TokenProvider,
} from "./auth.ts";
import { checkRegression, checkSla, type RegressionThresholds, type SlaThresholds } from "./gate.ts";
import { formatInstrumentation } from "./instrument.ts";
import { defaultSpec, formatMode, type ModeName, type ModeSpec } from "./modes.ts";
import {
  checkSafety,
  countSetupCommands,
  DEFAULT_LIMITS,
  describePlan,
  isLocalEndpoint,
  type RunPlan,
  type SafetyLimits,
} from "./safety.ts";
import { LedgerClient } from "./ledger.ts";
import {
  buildPresetWorkload,
  prepareRun,
  preparedState,
  runWorkload,
  type LoadModel,
  type LoadReport,
} from "./load.ts";
import {
  appendHistory,
  checkTrend,
  formatTrend,
  loadHistory,
  summarizeTrend,
  toHistoryEntry,
  type TrendThresholds,
} from "./history.ts";
import { formatSummary } from "./metrics.ts";
import { renderPrometheus } from "./prometheus.ts";
import { renderReport, renderSweep } from "./render.ts";
import { startSandbox, type SandboxHandle } from "./sandbox.ts";
import { runSweep, type SweepReport } from "./sweep.ts";
import { stdioWorkerMain } from "./worker.ts";
import {
  applyParams,
  requiredParams,
  toSetupSteps,
  validateWorkload,
  WORKLOAD_FORMAT_VERSION,
  type Workload,
  type WorkloadParams,
} from "./workload.ts";
import { formatVerdict } from "./verdict.ts";
import { inspectDar } from "./inspect.ts";
import { planTransfer } from "./plan.ts";
import { scaffold } from "./scaffold.ts";

const USAGE = `usage:
  canton-stress run [<dar>] --template <templateId>
    [--workload create|transfer | --workload-file <json>]
    [--model closed|open] [--concurrency n] [--rate ops/sec] [--max-in-flight n]
    [--sweep n,n,n]        sweep the load dimension (concurrency for closed, rate for open)
    [--mode ramp|soak|spike|stress]   a test mode; --rate is the target/baseline
      [--duration s]       length of the run (default 60s, soak 300s)
      [--from n] [--to n]  override the mode's rate range (spike: baseline/burst)
      [--bucket s]         time-series bucket width
    [--ops n] [--warmup n] [--parties n] [--amount d] [--seed n]
    [--api <url>] [--sandbox] [--java-home <dir>]
    [--transfer-choice <name>] [--new-owner-field <name>] [--create-args <json>]
    [--report <file>]
    [--setup-only]         run the workload's setup program, print what it bound, and stop
    [--workers n]          drive load from n processes (lifts the single-process ceiling)
    [--worker-cmd "<cmd>"] run each worker via <cmd> instead of forking locally,
                           e.g. "ssh perf-box canton-stress worker" — the worker
                           speaks line-delimited JSON on stdio, so any transport works
    [--api url[,url…]]     one or more participants; workers spread over them round-robin
    [--auth-token <jwt> | --auth-token-file <path>]   bearer token for the Ledger API
    [--auth-oauth-url <url> --auth-client-id <id> --auth-client-secret <secret>]
                           OAuth client-credentials, refreshed before expiry
      [--auth-scope <s>] [--auth-audience <a>]
    [--auth-hs256-secret <secret>]   TEST ONLY: mint tokens for a participant
                           configured with unsafe-jwt-hmac-256
    [--dry-run]            print exactly what WOULD be submitted, submit nothing
    [--allow-remote]       required to drive a participant that is not on this machine
    [--max-rate n] [--max-ops n] [--max-duration s]   raise the safety caps
    [--lag-sample ms]      sample read-side lag during the run (0 = off)
    [--no-traffic]         skip the CIP-0104 traffic cost estimation
    [--traffic-price usd]  price envelope bytes at USD per MB (e.g. 60), giving
                           a cost per operation alongside the size
    [--min-throughput n] [--max-p99 ms] [--max-contention pct]   SLA gate → non-zero exit on breach
    [--max-hotspot-share pct] [--max-read-lag offsets]           SLA gate on Canton instrumentation

    [--prometheus <file>]  also write Prometheus text-format metrics
    [--metric-label k=v]   extra label on every exported metric (repeatable)
    [--history <file.jsonl>] append this run, and compare it to the rolling median
      [--run-label <text>]   a marker for the entry (commit sha, branch, release)
      [--max-drop-vs-median pct] [--max-p99-rise-vs-median pct]   trend gate

  canton-stress report <report|sweep.json> [--out <file.html>]
    [--baseline <report.json> --max-throughput-drop pct --max-p99-rise pct]   regression gate

  canton-stress scaffold <dar> [--out <file.json>] [--count n]
    generate a STARTING workload for any DAR: setup ordered by the dependency
    graph the DAR itself states, with TODO markers where a value could not be
    inferred. Writes the file and stops — it does not run it.

  canton-stress check <workload.json>
    validate a workload file (refs, roles, weights) without touching a ledger`;

function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

const stripBom = (s: string): string => s.replace(/^﻿/, ""); // tolerate UTF-8 BOM (Windows)

function parseJson(label: string, raw: string): Record<string, unknown> {
  try {
    return JSON.parse(stripBom(raw)) as Record<string, unknown>;
  } catch {
    fail(`${label} must be valid JSON`);
  }
}

function readJsonFile<T>(path: string): T {
  return JSON.parse(stripBom(readFileSync(path, "utf8"))) as T;
}

/** Read a workload file, substitute its parameters, and refuse to run an
 * invalid one — a mistyped "$ref" should cost milliseconds, not a sandbox boot
 * and half a setup run. */
function loadWorkloadFile(path: string, params: WorkloadParams = {}): Workload {
  let w = readJsonFile<Workload>(path);
  try {
    w = applyParams(w, params);
  } catch (e) {
    fail(`${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const problems = validateWorkload(w);
  if (problems.length > 0)
    fail([`invalid workload ${path}:`, ...problems.map((p) => `  - ${p}`)].join("\n"));
  return w;
}

/**
 * What the FIX arithmetic needs, read off the workload itself.
 *
 * The workload is the source of truth for both figures, so this works for a
 * hand-written file as well as an auto-planned one: the pool is the repetition
 * count of the setup step the measured op draws its inputs from, and the input
 * count is how many contracts one operation nominates.
 */
function verdictShape(w: Workload): { pool?: number; inputs?: number } {
  // The measured op's input list, wherever it sits in the argument record.
  let inputs: number | undefined;
  let poolBinding: string | undefined;
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      const refs = v.filter((x): x is string => typeof x === "string" && x.startsWith("$ref:"));
      // An array made entirely of pool references IS the input list.
      if (refs.length > 0 && refs.length === v.length) {
        inputs = refs.length;
        poolBinding = /^\$ref:([A-Za-z0-9_-]+)/.exec(refs[0])?.[1];
      }
      for (const x of v) walk(x);
    } else if (v && typeof v === "object") {
      for (const x of Object.values(v as Record<string, unknown>)) walk(x);
    }
  };
  for (const o of w.operations) walk(o.op.args);

  // Setup accepts both the bare-op and full-step forms; only steps carry ids.
  const step = toSetupSteps(w.setup ?? []).find((s) => s.id === poolBinding);
  const count = typeof step?.count === "number" ? step.count : undefined;
  return { pool: count, inputs };
}

async function runMain(rest: string[]): Promise<void> {
  let dar: string | null = null;
  let templateId = "#daml-fuzz-sample:SampleToken:Token";
  let workloadName: "create" | "transfer" = "create";
  let workloadFile: string | null = null;
  const params: WorkloadParams = {};
  let modelKind: "closed" | "open" = "closed";
  let parties = 3;
  let ops = 200;
  let warmup = 0;
  let concurrency = 16;
  let rate = 100;
  let maxInFlight: number | undefined;
  let amount = "100.0";
  let seed = 42;
  let api = "http://localhost:7575";
  let useSandbox = false;
  let javaHome: string | undefined;
  let transferChoice = "Transfer";
  let transferNewOwnerField = "newOwner";
  let createArgs: Record<string, unknown> | undefined;
  let report: string | null = null;
  let prometheusFile: string | null = null;
  const metricLabels: Record<string, string> = {};
  let historyFile: string | null = null;
  let runLabel: string | undefined;
  const trend: TrendThresholds = {};
  let sweepLevels: number[] | null = null;
  let setupOnly = false;
  let setupConcurrency = 8;
  let lagSampleMs = 0;
  let noTraffic = false;
  let usdPerMb: number | undefined;
  let workers = 1;
  let workerCmd: string | undefined;
  let opsSet = false;
  let dryRun = false;
  let authToken: string | undefined;
  let authTokenFile: string | undefined;
  let hs256Secret: string | undefined;
  const oauth: Partial<OAuthConfig> = {};
  const limits: SafetyLimits = { ...DEFAULT_LIMITS };
  let mode: ModeName | null = null;
  let durationMs: number | undefined;
  let fromRate: number | undefined;
  let toRate: number | undefined;
  let bucketMs: number | undefined;
  const sla: SlaThresholds = {};
  let verdict = false;
  let verdictNoun: string | undefined;
  let verdictSubject: string | undefined;

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const val = () => rest[++i] ?? fail(`${a} needs a value`);
    if (a === "--verdict") verdict = true;
    else if (a === "--verdict-noun") verdictNoun = val();
    else if (a === "--verdict-subject") verdictSubject = val();
    else if (a === "--template") templateId = val();
    else if (a === "--workload") {
      const w = val();
      if (w !== "create" && w !== "transfer") fail("--workload must be create|transfer");
      workloadName = w;
    } else if (a === "--workload-file") workloadFile = val();
    else if (a === "--set") {
      const raw = val();
      const eq = raw.indexOf("=");
      if (eq < 1) fail(`--set needs <name>=<value> (got: ${raw})`);
      params[raw.slice(0, eq)] = raw.slice(eq + 1);
    } else if (a === "--set-json") {
      const raw = val();
      const eq = raw.indexOf("=");
      if (eq < 1) fail(`--set-json needs <name>=<json> (got: ${raw})`);
      try {
        params[raw.slice(0, eq)] = JSON.parse(raw.slice(eq + 1));
      } catch {
        fail(`--set-json ${raw.slice(0, eq)}= must be valid JSON`);
      }
    }
    else if (a === "--model") {
      const m = val();
      if (m !== "closed" && m !== "open") fail("--model must be closed|open");
      modelKind = m;
    } else if (a === "--parties") parties = Number(val());
    else if (a === "--ops") {
      ops = Number(val());
      opsSet = true;
    }
    else if (a === "--warmup") warmup = Number(val());
    else if (a === "--concurrency") concurrency = Number(val());
    else if (a === "--rate") rate = Number(val());
    else if (a === "--max-in-flight") maxInFlight = Number(val());
    else if (a === "--amount") amount = val();
    else if (a === "--seed") seed = Number(val());
    else if (a === "--api") api = val();
    else if (a === "--sandbox") useSandbox = true;
    else if (a === "--java-home") javaHome = val();
    else if (a === "--transfer-choice") transferChoice = val();
    else if (a === "--new-owner-field") transferNewOwnerField = val();
    else if (a === "--create-args") createArgs = parseJson("--create-args", val());
    else if (a === "--report") report = val();
    else if (a === "--prometheus") prometheusFile = val();
    else if (a === "--history") historyFile = val();
    else if (a === "--run-label") runLabel = val();
    else if (a === "--max-drop-vs-median") trend.maxThroughputDropPct = Number(val());
    else if (a === "--max-p99-rise-vs-median") trend.maxP99RisePct = Number(val());
    else if (a === "--metric-label") {
      const raw = val();
      const eq = raw.indexOf("=");
      if (eq < 1) fail(`--metric-label needs <key>=<value> (got: ${raw})`);
      metricLabels[raw.slice(0, eq)] = raw.slice(eq + 1);
    }
    else if (a === "--setup-only") setupOnly = true;
    else if (a === "--setup-concurrency") setupConcurrency = Number(val());
    else if (a === "--sweep") sweepLevels = val().split(",").map((x) => Number(x.trim()));
    else if (a === "--mode") {
      const m = val();
      if (m !== "ramp" && m !== "soak" && m !== "spike" && m !== "stress")
        fail("--mode must be ramp|soak|spike|stress");
      mode = m;
    } else if (a === "--duration") durationMs = Number(val()) * 1000;
    else if (a === "--from") fromRate = Number(val());
    else if (a === "--to") toRate = Number(val());
    else if (a === "--bucket") bucketMs = Number(val()) * 1000;
    else if (a === "--auth-token") authToken = val();
    else if (a === "--auth-token-file") authTokenFile = val();
    else if (a === "--auth-oauth-url") oauth.tokenUrl = val();
    else if (a === "--auth-client-id") oauth.clientId = val();
    else if (a === "--auth-client-secret") oauth.clientSecret = val();
    else if (a === "--auth-scope") oauth.scope = val();
    else if (a === "--auth-audience") oauth.audience = val();
    else if (a === "--auth-hs256-secret") hs256Secret = val();
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--allow-remote") limits.allowRemote = true;
    else if (a === "--max-rate") limits.maxRate = Number(val());
    else if (a === "--max-ops") limits.maxOps = Number(val());
    else if (a === "--max-duration") limits.maxDurationMs = Number(val()) * 1000;
    else if (a === "--workers") workers = Number(val());
    else if (a === "--worker-cmd") workerCmd = val();
    else if (a === "--lag-sample") lagSampleMs = Number(val());
    else if (a === "--no-traffic") noTraffic = true;
    else if (a === "--traffic-price") usdPerMb = Number(val());
    else if (a === "--min-throughput") sla.minThroughput = Number(val());
    else if (a === "--max-p99") sla.maxP99Ms = Number(val());
    else if (a === "--max-contention") sla.maxContentionPct = Number(val());
    else if (a === "--max-hotspot-share") sla.maxHotspotSharePct = Number(val());
    else if (a === "--max-read-lag") sla.maxReadLagOffsets = Number(val());
    else if (a.startsWith("--")) fail(`unknown option ${a}\n${USAGE}`);
    else if (dar === null) dar = a;
    else fail(USAGE);
  }
  if (useSandbox && !dar) fail("--sandbox needs a <dar> to boot from");

  const workload: Workload = workloadFile
    ? loadWorkloadFile(workloadFile, params)
    : buildPresetWorkload({
        workload: workloadName,
        templateId,
        parties,
        poolSize: Math.max((modelKind === "open" ? maxInFlight ?? rate : concurrency) * 2, 8),
        transferChoice,
        transferNewOwnerField,
        createArgs,
      });

  // [S5] A mode drives the arrival rate over time. Offered load is the
  // independent variable, and a closed model has none — it self-paces — so
  // only soak (endurance at fixed concurrency) makes sense there.
  let modeSpec: ModeSpec | undefined;
  if (mode) {
    if (modelKind === "closed" && mode !== "soak")
      fail(
        `--mode ${mode} needs --model open: it varies the OFFERED load, and a closed model ` +
          `self-paces (there is no offered rate to vary). Use --model open, or --mode soak.`,
      );
    modeSpec = defaultSpec(mode, { rate, durationMs });
    if (fromRate !== undefined) modeSpec.fromRate = fromRate;
    if (toRate !== undefined) modeSpec.toRate = toRate;
    if (bucketMs !== undefined) modeSpec.bucketMs = bucketMs;
    if (sweepLevels) fail("--mode and --sweep are different experiments; run them separately");
    // A mode run is timed, not counted. Leave --ops as an explicit safety cap
    // if the user set one, but do not let the default 200 truncate a ramp.
    if (!opsSet) ops = 0;
  }

  const model: LoadModel =
    modelKind === "open"
      ? { kind: "open", ops, warmup, rate, maxInFlight, modeSpec, durationMs, warmupMs: undefined }
      : { kind: "closed", ops, warmup, concurrency, modeSpec, durationMs };

  // [S6] --api may name several participants; workers spread over them. The
  // coordinator itself (setup, party allocation) talks to the first one.
  let endpoints = api.split(",").map((s) => s.trim()).filter(Boolean);
  if (endpoints.length === 0) fail("--api needs at least one url");
  api = endpoints[0];

  if (workers < 1 || !Number.isInteger(workers)) fail("--workers must be a positive integer");

  // [S8] Safety, BEFORE anything is submitted and before a sandbox is even
  // booted: the whole point is that a mistake costs nothing.
  const plan: RunPlan = {
    endpoints,
    workers,
    model,
    workload,
    workloadLabel: workloadFile ? `file:${workloadFile}` : workloadName,
    modeSpec,
    setupCommands: countSetupCommands(workload),
    sandbox: useSandbox,
  };
  const problems = checkSafety(plan, limits);
  if (problems.length > 0) {
    console.error("\ncanton-stress REFUSED to run:\n");
    for (const p of problems) console.error(`  - ${p}`);
    console.error(`\nThe plan it refused:\n${describePlan(plan)}`);
    process.exit(2);
  }
  if (dryRun) {
    console.error(`\ncanton-stress DRY RUN — nothing will be submitted:\n\n${describePlan(plan)}`);
    console.error(
      `\nworkload validates; safety checks pass. Remove --dry-run to execute.` +
        (useSandbox ? "" : `\nTarget is ${endpoints.every(isLocalEndpoint) ? "local" : "REMOTE"}.`),
    );
    return;
  }
  // Driving someone else's participant is allowed, but never quietly: show the
  // blast radius before the first command goes out.
  if (!useSandbox && !endpoints.every(isLocalEndpoint))
    console.error(
      `\n!! REMOTE TARGET — generating load against ${endpoints.join(", ")}\n${describePlan(plan)}\n`,
    );

  let sandbox: SandboxHandle | null = null;
  if (useSandbox) {
    console.error("starting sandbox…");
    sandbox = await startSandbox({ dar: dar!, javaHome });
    api = sandbox.apiUrl;
    endpoints = [api];
    console.error(`sandbox ready at ${api}`);
  }

  const runId = Date.now().toString(36);
  // [S6] One client per participant. `client` is the coordinator's own
  // connection (setup, party allocation, version probes); `network` is the
  // whole thing, which is what a placement-aware run needs.
  // [auth] Every real participant requires a bearer token; only a dev sandbox
  // does not. Env var is supported so a token never has to appear in a shell
  // history or a CI log.
  let auth: TokenProvider = noAuth;
  let authUserId: string | undefined;
  const envToken = process.env.CANTON_STRESS_TOKEN;
  if (hs256Secret) {
    authUserId = "participant_admin";
    auth = hs256Provider(hs256Secret, { userId: authUserId });
  } else if (authToken) auth = staticToken(authToken);
  else if (authTokenFile) auth = tokenFromFile(authTokenFile);
  else if (envToken) auth = staticToken(envToken);
  else if (oauth.tokenUrl) {
    if (!oauth.clientId || !oauth.clientSecret)
      fail("--auth-oauth-url needs --auth-client-id and --auth-client-secret");
    auth = oauthClientCredentials(oauth as OAuthConfig);
  }

  // The userId on a submission must match the token's subject — a token that
  // says "participant_admin" cannot submit as "ledger-api-user".
  const clients = endpoints.map((e) => new LedgerClient(e, authUserId ?? "ledger-api-user", auth));
  const client = clients[0];
  const network = clients.length > 1 ? clients : client;
  const label = workloadFile ? `file:${workloadFile}` : workloadName;
  // Canton 3.x authorises via user management, so a freshly allocated party is
  // not usable until the authenticated user has rights over it.
  const onPartiesAllocated = async (ps: string[]): Promise<void> => {
    if (!authUserId) return;
    try {
      await Promise.all(clients.map((c) => c.grantRights(authUserId!, ps)));
    } catch (e) {
      console.error(`  warning: could not grant rights to ${authUserId}: ${String(e).slice(0, 200)}`);
    }
  };
  const runOpts = { amount, seed, runId, onPartiesAllocated, setupConcurrency };
  const onSetupStep = (i: number, label: string, bound: number) =>
    console.error(`  setup ${i + 1}: ${label}${bound > 0 ? ` → bound ${bound}` : ""}`);

  try {
    if (setupOnly) {
      console.error(`\ncanton-stress SETUP-ONLY: workload=${label} parties=${workload.parties}`);
      const prep = await prepareRun(network, workload, { ...runOpts, onSetupStep });
      console.error(`\nsetup complete: ${prep.setup.submitted} commands over ${prep.setup.steps} steps`);
      console.error("bindings:");
      for (const [name, cids] of Object.entries(prep.bindings))
        console.error(`  ${name}: ${cids.length} contract(s)  e.g. ${cids[0]?.slice(0, 24) ?? "-"}…`);
      if (Object.keys(prep.roles).length > 0) {
        console.error("roles:");
        for (const [name, p] of Object.entries(prep.roles)) console.error(`  ${name}: ${p}`);
      }
      // [S6] Which node hosts what — the thing that decides who can sign.
      if (endpoints.length > 1) {
        console.error("placement:");
        endpoints.forEach((e, idx) => {
          const here = Object.entries(prep.hostOf).filter(([, h]) => h === idx);
          console.error(`  ${e}: ${here.length} part(ies) — ${here.map(([p]) => p.split("::")[0]).join(", ")}`);
        });
      }
      // [S6] Only the WORKER COUNT selects the distributed path. Several
      // endpoints on their own mean a multi-participant network, which the
      // in-process runner drives directly — conflating the two sent every
      // submission to one node and rejected every cross-participant op.
    } else if (workers > 1) {
      // [S6] Distributed: setup once here, then fan the measured window out
      // across worker processes so the generator is not the bottleneck.
      console.error(
        `\ncanton-stress CLUSTER: workload=${label} model=${modelKind} workers=${workers} ` +
          `endpoints=${endpoints.length} ops=${ops} ` +
          `${modelKind === "open" ? `rate=${rate}/s total` : `concurrency=${concurrency} total`}`,
      );
      const prep = await prepareRun(network, workload, { ...runOpts, onSetupStep });
      const shares = splitModel(model, workers);
      const assigned = assignEndpoints(endpoints, workers);
      const jobs: WorkerJob[] = shares.map((m, i) => ({
        workerIndex: i,
        api: assigned[i],
        // Placed workloads need every node reachable from every worker.
        apis: workload.placement === "round-robin" ? endpoints : undefined,
        workload,
        model: m,
        state: preparedState(prep),
        // Distinct per worker: the participant deduplicates on the command id.
        runId: `${runId}w${i}`,
        seed,
        amount,
        lagSampleMs: i === 0 ? lagSampleMs : 0, // one sampler is enough
        noTraffic: noTraffic || i > 0, // price the operations once
      }));
      for (const j of jobs)
        console.error(
          `  worker ${j.workerIndex} → ${j.api}: ${j.model.ops} ops, ` +
            `${j.model.kind === "open" ? `${Math.round((j.model.rate ?? 0) * 10) / 10}/s` : `concurrency ${j.model.concurrency}`}`,
        );
      const parts = await runWorkers(jobs, { onEvent: (m) => console.error(`  ${m}`), workerCmd });
      const synchronizerId = await client.connectedSynchronizerId().catch(() => undefined);
      const merged = mergeResults(parts, model, workload, synchronizerId);
      merged.setup = prep.setup.steps > 0 ? prep.setup : undefined;

      console.error(`\nRESULT — ${modelKind} model, ${workers} workers (pooled):`);
      console.error(formatSummary(merged.summary));
      console.error(`\nCLUSTER:\n${formatCluster(merged.cluster)}`);
      if (merged.instrumentation) {
        const block = formatInstrumentation(merged.instrumentation);
        if (block) console.error(`\nCANTON INSTRUMENTATION:\n${block}`);
      }
      if (report) {
        writeFileSync(report, JSON.stringify(merged, null, 2) + "\n");
        console.error(`\nreport written to ${report}`);
      }
      if (Object.values(sla).some((v) => v !== undefined)) {
        const gate = checkSla(merged.summary, sla, merged.instrumentation);
        if (gate.pass) {
          console.error("\nSLA: PASS");
        } else {
          console.error("\nSLA: FAIL");
          for (const f of gate.failures) console.error(`  - ${f}`);
          process.exitCode = 1;
        }
      }
    } else if (sweepLevels) {
      console.error(
        `\ncanton-stress SWEEP: workload=${label} model=${modelKind} ` +
          `${modelKind === "open" ? "rates" : "concurrencies"}=[${sweepLevels.join(", ")}] ops=${ops}`,
      );
      const sweep = await runSweep(network, workload, model, sweepLevels, runOpts);
      console.error("\nRESULT — sweep:");
      const dim = sweep.dimension;
      for (const pt of sweep.points) {
        const s = pt.report.summary;
        console.error(
          `  ${dim}=${pt.level}: ${Math.round(s.throughputPerSec * 10) / 10}/s throughput, ` +
            `p50 ${Math.round(s.latency.p50)}ms / p99 ${Math.round(s.latency.p99)}ms, ` +
            `${Math.round(s.contentionRate * 100)}% contention`,
        );
      }
      if (report) {
        writeFileSync(report, JSON.stringify(sweep, null, 2) + "\n");
        console.error(`\nsweep report written to ${report}  (render: canton-stress report ${report} --out out.html)`);
      }
    } else {
      console.error(
        modeSpec
          ? `\ncanton-stress ${modeSpec.mode.toUpperCase()}: workload=${label} model=${modelKind} ` +
            `parties=${workload.parties} duration=${modeSpec.durationMs / 1000}s ` +
            (modeSpec.mode === "spike"
              ? `baseline=${modeSpec.fromRate}/s burst=${modeSpec.toRate}/s`
              : modeSpec.mode === "soak"
                ? `rate=${modeSpec.fromRate}/s`
                : `rate ${modeSpec.fromRate}→${modeSpec.toRate}/s`)
          : `\ncanton-stress: workload=${label} model=${modelKind} parties=${workload.parties} ` +
            `ops=${ops} warmup=${warmup} ${modelKind === "open" ? `rate=${rate}/s` : `concurrency=${concurrency}`}`,
      );
      const rep = await runWorkload(network, workload, model, {
        ...runOpts,
        onSetupStep,
        lagSampleMs,
        noTraffic,
        usdPerMb,
        onProgress: (d, total) => {
          // A duration-driven run (a mode) has no op target, so tick
          // periodically instead of dividing by a total that does not exist.
          if (total <= 0) {
            if (d % 100 === 0) console.error(`  …${d} ops`);
          } else if (d === total || d % Math.max(1, Math.floor(total / 10)) === 0) {
            console.error(`  …${d}/${total}`);
          }
        },
      });
      console.error(`\nRESULT — ${modelKind} model:`);
      if (rep.model === "open")
        console.error(
          rep.targetRatePerSec === undefined
            ? `  arrival rate: achieved ${Math.round((rep.achievedRatePerSec ?? 0) * 10) / 10}/s (scheduled by the mode)`
            : `  arrival rate: target ${rep.targetRatePerSec}/s, achieved ${Math.round((rep.achievedRatePerSec ?? 0) * 10) / 10}/s`,
        );
      console.error(formatSummary(rep.summary));
      // [S5] What the mode concluded — the reason the run was shaped this way.
      if (rep.modeReport) console.error(`\n${rep.modeReport.mode.toUpperCase()} VERDICT:\n${formatMode(rep.modeReport)}`);
      // [S4] The Canton-specific block: which contract is serializing you,
      // whose latency it is, how far the read side trails, what it costs.
      if (rep.instrumentation) {
        const block = formatInstrumentation(rep.instrumentation);
        if (block) console.error(`\nCANTON INSTRUMENTATION:\n${block}`);
      }
      // Record what the verdict needs BEFORE writing the report, so a saved
      // report can render the same verdict later without the workload file.
      // A report that only makes sense next to the file that produced it is
      // not something anyone can forward.
      {
        const shape = verdictShape(workload);
        rep.shape = {
          pool: shape.pool,
          inputs: shape.inputs,
          noun: verdictNoun,
          subject: verdictSubject,
        };
      }
      // The answer, for people who came with a question rather than a
      // profiler. Printed last so the evidence is above it.
      if (verdict) {
        console.error(
          "\n" +
            formatVerdict({
              summary: rep.summary,
              instrumentation: rep.instrumentation,
              pool: rep.shape.pool,
              inputs: rep.shape.inputs,
              noun: rep.shape.noun,
              subject: rep.shape.subject,
            }),
        );
      }
      if (report) {
        writeFileSync(report, JSON.stringify(rep, null, 2) + "\n");
        console.error(`\nreport written to ${report}`);
      }
      if (prometheusFile) {
        writeFileSync(prometheusFile, renderPrometheus(rep, { labels: metricLabels }));
        console.error(`metrics written to ${prometheusFile}`);
      }
      // [M3] Append first, then compare — the history is the audit trail, and
      // a run that breaches its gate still belongs in it.
      if (historyFile) {
        appendHistory(historyFile, toHistoryEntry(rep, { runId, label: runLabel }));
        const hist = loadHistory(historyFile);
        const t = summarizeTrend(hist);
        console.error(`\nTREND (${hist.length} run(s) in ${historyFile}):\n${formatTrend(t, hist)}`);
        if (trend.maxThroughputDropPct !== undefined || trend.maxP99RisePct !== undefined) {
          const g = checkTrend(t, trend);
          if (g.pass) {
            console.error("TREND: PASS");
          } else {
            console.error("TREND: FAIL");
            for (const f of g.failures) console.error(`  - ${f}`);
            process.exitCode = 1;
          }
        }
      }
      // CI gate: fail the process if any SLA threshold is set and violated.
      if (Object.values(sla).some((v) => v !== undefined)) {
        const gate = checkSla(rep.summary, sla, rep.instrumentation);
        if (gate.pass) {
          console.error("\nSLA: PASS");
        } else {
          console.error("\nSLA: FAIL");
          for (const f of gate.failures) console.error(`  - ${f}`);
          process.exitCode = 1;
        }
      }
    }
  } finally {
    if (sandbox) {
      console.error("\nstopping sandbox…");
      await sandbox.stop();
    }
  }
}

const REPORT_USAGE =
  "usage: canton-stress report <report|sweep.json> [--out <file.html>]\n" +
  "         [--baseline <report.json> --max-throughput-drop <pct> --max-p99-rise <pct>]";

function reportMain(rest: string[]): void {
  let jsonFile: string | null = null;
  let out: string | null = null;
  let baseline: string | null = null;
  const reg: RegressionThresholds = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const val = () => rest[++i] ?? fail(`${a} needs a value`);
    if (a === "--out") out = val();
    else if (a === "--baseline") baseline = val();
    else if (a === "--max-throughput-drop") reg.maxThroughputDropPct = Number(val());
    else if (a === "--max-p99-rise") reg.maxP99RisePct = Number(val());
    else if (a.startsWith("--")) fail(`unknown option ${a}\n${REPORT_USAGE}`);
    else if (jsonFile === null) jsonFile = a;
    else fail(REPORT_USAGE);
  }
  if (!jsonFile) fail(REPORT_USAGE);

  const data = readJsonFile<LoadReport & Partial<SweepReport>>(jsonFile);
  const isSweep = Array.isArray(data.points);
  const html = isSweep ? renderSweep(data as SweepReport) : renderReport(data as LoadReport);
  if (out) {
    writeFileSync(out, html);
    console.error(`report written to ${out}`);
  } else {
    console.log(html);
  }

  // Regression gate: compare a single run against a saved baseline run.
  if (baseline) {
    if (isSweep) fail("--baseline compares single runs, not a sweep");
    const base = readJsonFile<LoadReport>(baseline);
    const gate = checkRegression((data as LoadReport).summary, base.summary, reg);
    if (gate.pass) {
      console.error("regression: PASS (within tolerance of baseline)");
    } else {
      console.error("regression: FAIL");
      for (const f of gate.failures) console.error(`  - ${f}`);
      process.exitCode = 1;
    }
  }
}

/** Validate a workload file offline — the fast feedback loop while writing one. */
/**
 * `canton-stress scaffold <dar> [--out file] [--count n]`
 *
 * Writes a starting workload for any DAR and stops. Deliberately does not run
 * it: the file contains inferred values and TODO markers, and a workload nobody
 * has read should not be driving load at anything.
 */
function scaffoldMain(rest: string[]): void {
  let dar: string | null = null;
  let out: string | null = null;
  let count: number | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--out") out = rest[++i] ?? fail("--out needs a value");
    else if (a === "--count") count = Number(rest[++i] ?? fail("--count needs a value"));
    else if (!a.startsWith("--") && !dar) dar = a;
    else fail(`unexpected argument "${a}"`);
  }
  if (!dar) fail("usage: canton-stress scaffold <dar> [--out <file.json>] [--count n]");

  let info;
  try {
    info = inspectDar(dar);
  } catch (e) {
    fail(String(e instanceof Error ? e.message : e));
  }

  // A Token Standard registry does not need scaffolding — it is fully planned.
  const planned = planTransfer(info);
  if (planned.ok) {
    console.error(
      `${basename(dar)} implements the Token Standard, so it needs no scaffold:\n` +
        `  canton-stress ${basename(dar)}\n` +
        `runs it directly with no configuration. Use --explain to see the parameters.`,
    );
    return;
  }

  const r = scaffold(info, { holdings: count });
  if (!r.ok) fail([`cannot scaffold ${basename(dar)}:`, ...r.reasons.map((x) => `  - ${x}`)].join("\n"));

  const file = out ?? `${info.packageName}-workload.json`;
  writeFileSync(file, JSON.stringify(r.scaffold.workload, null, 2) + "\n");

  console.error(`  Read ${basename(dar)} … ${info.templates.length} templates`);
  console.error(`  Setup order   ${r.scaffold.order.join(" → ")}`);
  console.error(`  Measuring     ${r.scaffold.measuring}`);
  console.error(`\nwrote ${file}`);
  if (r.scaffold.notes.length > 0) {
    console.error(`\n${r.scaffold.notes.length} value(s) could not be inferred — edit before running:`);
    for (const n of r.scaffold.notes) console.error(`  ${n.where}: ${n.what}`);
  }
  console.error(`\nthen:  canton-stress check ${file}`);
}

function checkMain(rest: string[]): void {
  const path = rest[0];
  if (!path || path.startsWith("--")) fail("usage: canton-stress check <workload.json>");
  const raw = readJsonFile<Workload>(path);
  // A library workload is a template: report what it needs rather than
  // failing on placeholders that the caller is expected to supply.
  const needed = requiredParams(raw);
  if (needed.length > 0) {
    console.error(`${path}: template — requires ${needed.length} parameter(s):`);
    for (const n of needed) console.error(`  --set ${n}=<value>`);
    return;
  }
  const w = raw;
  const problems = validateWorkload(w);
  if (problems.length > 0) {
    console.error(`invalid workload ${path}:`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exitCode = 1;
    return;
  }
  const steps = Array.isArray(w.setup) ? w.setup.length : 0;
  console.error(
    `${path}: OK — ${w.parties} parties, ${(w.roles ?? []).length} role(s), ` +
      `${steps} setup step(s), ${w.operations.length} operation(s)`,
  );
}

/** Read the version from package.json — one source of truth, so a release
 * bump cannot leave the binary reporting a stale number. */
function toolVersion(): string {
  try {
    const pkg = readJsonFile<{ version?: string }>(
      fileURLToPath(new URL("../package.json", import.meta.url)),
    );
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Inspect a performance history without running anything. */
function trendMain(rest: string[]): void {
  const path = rest[0];
  if (!path || path.startsWith("--"))
    fail("usage: canton-stress trend <history.jsonl> [--window n]");
  let window = 10;
  for (let i = 1; i < rest.length; i++)
    if (rest[i] === "--window") window = Number(rest[++i] ?? fail("--window needs a value"));

  const hist = loadHistory(path);
  if (hist.length === 0) fail(`no readable runs in ${path}`);

  console.error(`${path}: ${hist.length} run(s)\n`);
  const r1 = (n: number) => Math.round(n * 10) / 10;
  for (const e of hist.slice(-15))
    console.error(
      `  ${e.at.slice(0, 19).replace("T", " ")}  ${String(r1(e.throughputPerSec)).padStart(7)}/s  ` +
        `p99 ${String(r1(e.p99Ms)).padStart(7)}ms  ${String(r1(e.contentionRate * 100)).padStart(5)}% cont` +
        (e.label ? `  ${e.label}` : ""),
    );
  console.error(`\n${formatTrend(summarizeTrend(hist, window), hist)}`);
}

/**
 * `canton-stress <dar>` — the zero-configuration path.
 *
 * Reads the DAR, decides what is worth measuring, generates the parameters for
 * the published library workload, and runs it. No file to author and no flags
 * for the common case; every flag still works and overrides what is inferred,
 * because the generated arguments are placed BEFORE the user's.
 */
async function autoMain(dar: string, rest: string[]): Promise<void> {
  let info;
  try {
    info = inspectDar(dar);
  } catch (e) {
    fail(String(e instanceof Error ? e.message : e));
  }
  const named = `${info.packageName}${info.packageVersion ? " " + info.packageVersion : ""}`;
  console.error(`  Reading ${basename(dar)} … ${named}, ${info.templates.length} templates`);

  const planned = planTransfer(info);
  if (!planned.ok) {
    // Refusing is the honest outcome, but it should still leave the user
    // somewhere: the library templates cover cases this cannot infer.
    fail(
      [
        `cannot plan a run for ${basename(dar)} automatically:`,
        ...planned.reasons.map((r) => `  - ${r}`),
        "",
        "The zero-configuration path handles Canton Network Token Standard",
        "registries. For anything else, start from a library workload:",
        "  canton-stress check workloads/create-throughput.json",
        "and see workloads/README.md.",
      ].join("\n"),
    );
  }
  const { plan } = planned;
  const p = plan.params;
  console.error(
    `  Measuring TransferFactory_Transfer on ${plan.factory.name} … Token Standard registry`,
  );
  console.error(
    `  Test data ${p.holdings} × ${plan.holding.name}, ${p.parties} parties, instrument "${p.instrumentId}"`,
  );
  for (const n of plan.notes) console.error(`    note: ${n}`);

  const explain = rest.includes("--explain");
  if (explain) {
    console.error("\n  generated parameters:");
    for (const [k, v] of Object.entries(p))
      console.error(`    ${k} = ${typeof v === "string" ? v : JSON.stringify(v)}`);
  }

  const workloadFile = fileURLToPath(
    new URL("../workloads/token-standard-transfer.json", import.meta.url),
  );
  const set = (k: string, v: unknown): string[] =>
    typeof v === "string" ? ["--set", `${k}=${v}`] : ["--set-json", `${k}=${JSON.stringify(v)}`];

  const generated = [
    dar,
    "--workload-file",
    workloadFile,
    ...Object.entries(p).flatMap(([k, v]) => set(k, v)),
    "--model",
    "closed",
    "--concurrency",
    "8",
    "--ops",
    "240",
    "--verdict",
    "--verdict-noun",
    "transfers",
    "--verdict-subject",
    plan.holding.name,
  ];
  // Boot a sandbox unless the user pointed at a participant themselves.
  if (!rest.includes("--api") && !rest.includes("--sandbox")) generated.push("--sandbox");

  // The user's flags come last, so any of them beats the inferred value.
  await runMain([...generated, ...rest.filter((a) => a !== "--explain")]);
}

function main(argv: string[]): void {
  const [command, ...rest] = argv;
  if (command === "--version" || command === "-v" || command === "version") {
    console.log(`canton-stress ${toolVersion()} (workload format v${WORKLOAD_FORMAT_VERSION})`);
    return;
  }
  if (command === "--help" || command === "-h" || command === "help") {
    console.log(USAGE);
    return;
  }
  if (command === "run") {
    runMain(rest).catch((e) => fail(String(e instanceof Error ? e.message : e)));
    return;
  }
  if (command === "report") return reportMain(rest);
  if (command === "scaffold") return scaffoldMain(rest);
  if (command === "check") return checkMain(rest);
  if (command === "trend") return trendMain(rest);
  // `canton-stress wallet.dar` — a DAR where a subcommand would go means
  // "just measure this", which is the common case and should need nothing else.
  if (command && /\.dar$/i.test(command)) {
    autoMain(command, rest).catch((e) => fail(String(e instanceof Error ? e.message : e)));
    return;
  }
  if (command === "worker") {
    // A load-generating worker: one job in on stdin, one result out on stdout.
    // Invoked by a coordinator's --worker-cmd, locally or over ssh/k8s.
    stdioWorkerMain().catch((e) => fail(String(e instanceof Error ? e.message : e)));
    return;
  }
  fail(USAGE);
}

main(process.argv.slice(2));
