// Guardrails (roadmap S8).
//
// Every other module in this tool tries to generate as much load as it can.
// This one is the counterweight. A load generator is the one kind of test tool
// that can cause the incident it was meant to prevent: point it at the wrong
// URL, or fat-finger `--rate 1000` instead of `--rate 100`, and you have run a
// denial-of-service against someone's ledger.
//
// Two principles:
//
//   1. **Remote targets are opt-in.** Driving anything that is not on this
//      machine requires saying so explicitly. The default cannot be "hammer
//      whatever host happens to be in the flag".
//   2. **Limits are on by default.** A cap you have to remember to set is not
//      a safety feature. These are deliberately generous — they exist to catch
//      typos and runaway configs, not to get in the way — and every refusal
//      names the exact flag that lifts it.

import type { LoadModel } from "./load.ts";
import type { ModeSpec } from "./modes.ts";
import type { Workload } from "./workload.ts";

export interface SafetyLimits {
  /** Ceiling on offered ops/sec (peak, for a mode). */
  maxRate: number;
  /** Ceiling on total operations in one invocation. */
  maxOps: number;
  /** Ceiling on how long one invocation may run. */
  maxDurationMs: number;
  /** Permit endpoints that are not on this machine. */
  allowRemote: boolean;
}

/** Generous enough never to interrupt honest work; tight enough that a
 * mistyped rate or a runaway duration is stopped before it reaches a ledger. */
export const DEFAULT_LIMITS: SafetyLimits = {
  maxRate: 1000,
  maxOps: 1_000_000,
  maxDurationMs: 60 * 60_000, // 1 hour
  allowRemote: false,
};

/** Is this endpoint on the machine running the test? */
export function isLocalEndpoint(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false; // unparseable → treat as remote, i.e. require opt-in
  }
  // Strip IPv6 brackets if the URL parser left them.
  host = host.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1" || host === "0.0.0.0") return true;
  return /^127\./.test(host);
}

/** A description of what a run WOULD do, before anything is submitted. */
export interface RunPlan {
  endpoints: string[];
  workers: number;
  model: LoadModel;
  workload: Workload;
  workloadLabel: string;
  modeSpec?: ModeSpec;
  /** Setup commands the plan will submit before measuring. */
  setupCommands: number;
  sandbox: boolean;
}

/** Peak offered rate the plan will reach — the number a cap must be checked
 * against. A ramp's peak is its end, not its start. */
export function peakRate(model: LoadModel, modeSpec?: ModeSpec): number | undefined {
  if (model.kind !== "open") return undefined;
  if (modeSpec) return Math.max(modeSpec.fromRate, modeSpec.toRate);
  return model.rate;
}

/** How many commands the setup program will submit (repetitions included). */
export function countSetupCommands(workload: Workload): number {
  let n = 0;
  for (const s of workload.setup) n += "kind" in s ? 1 : (s.count ?? 1);
  return n;
}

/** Check a plan against the limits. Returns blocking problems, each naming the
 * flag that would permit it. Empty means the run may proceed. */
export function checkSafety(plan: RunPlan, limits: SafetyLimits): string[] {
  const problems: string[] = [];

  // 1. Targeting. A sandbox is booted by us on this machine, so it is exempt.
  if (!plan.sandbox && !limits.allowRemote) {
    const remote = plan.endpoints.filter((e) => !isLocalEndpoint(e));
    if (remote.length > 0)
      problems.push(
        `refusing to generate load against a non-local participant: ${remote.join(", ")}. ` +
          `This tool exists to saturate a ledger — confirm you mean THIS one with --allow-remote.`,
      );
  }

  // 2. Rate. Checked against the PEAK, and against the aggregate across
  // workers, since n workers at r/s each offer n×r to the participant.
  const peak = peakRate(plan.model, plan.modeSpec);
  if (peak !== undefined && peak > limits.maxRate)
    problems.push(
      `offered rate ${round(peak)}/s exceeds the safety cap of ${limits.maxRate}/s ` +
        `(raise it with --max-rate ${Math.ceil(peak)} if that is really intended)`,
    );

  // 3. Volume.
  const totalOps = plan.model.ops + plan.model.warmup;
  if (totalOps > limits.maxOps)
    problems.push(
      `${totalOps} operations exceeds the safety cap of ${limits.maxOps} ` +
        `(raise it with --max-ops ${totalOps})`,
    );

  // 4. Duration.
  const duration = plan.model.durationMs ?? plan.modeSpec?.durationMs;
  if (duration !== undefined && duration > limits.maxDurationMs)
    problems.push(
      `a ${round(duration / 1000)}s run exceeds the safety cap of ` +
        `${round(limits.maxDurationMs / 1000)}s (raise it with --max-duration ${Math.ceil(duration / 1000)})`,
    );

  return problems;
}

const round = (n: number): number => Math.round(n * 10) / 10;

/** The human-readable plan: what would be submitted, where, and how hard.
 * Printed by --dry-run, and also on any run against a remote target so the
 * operator sees the blast radius before it happens. */
export function describePlan(plan: RunPlan): string {
  const m = plan.model;
  const peak = peakRate(m, plan.modeSpec);
  const duration = m.durationMs ?? plan.modeSpec?.durationMs;

  const lines = [
    `  target:     ${plan.endpoints.join(", ")}${plan.sandbox ? "  (local sandbox, booted by this run)" : ""}`,
    `  workload:   ${plan.workloadLabel} — ${plan.workload.parties} parties` +
      `${(plan.workload.roles ?? []).length > 0 ? ` + roles [${(plan.workload.roles ?? []).join(", ")}]` : ""}`,
    `  setup:      ${plan.setupCommands} command(s) before measuring`,
    `  model:      ${m.kind}${plan.modeSpec ? ` / ${plan.modeSpec.mode}` : ""}`,
  ];

  if (m.kind === "open") {
    lines.push(
      plan.modeSpec
        ? `  arrivals:   ${plan.modeSpec.fromRate}/s → ${plan.modeSpec.toRate}/s (peak ${round(peak ?? 0)}/s)`
        : `  arrivals:   ${round(peak ?? 0)}/s`,
    );
  } else {
    lines.push(`  concurrency: ${m.concurrency ?? 16} in flight`);
  }

  lines.push(
    duration !== undefined
      ? `  extent:     ${round(duration / 1000)}s${m.ops > 0 ? `, capped at ${m.ops} ops` : ""}`
      : `  extent:     ${m.ops} operations${m.warmup > 0 ? ` (+${m.warmup} warmup)` : ""}`,
  );
  if (plan.workers > 1) lines.push(`  workers:    ${plan.workers} processes`);

  // The number that matters for blast radius: what the ledger will actually be
  // asked to absorb, in total.
  const estimate = estimateTotalCommands(plan);
  lines.push(`  ESTIMATED TOTAL COMMANDS SUBMITTED: ~${estimate}`);
  return lines.join("\n");
}

/** Rough upper bound on commands this run will send — setup plus measured. */
export function estimateTotalCommands(plan: RunPlan): number {
  const m = plan.model;
  const duration = m.durationMs ?? plan.modeSpec?.durationMs;
  let measured = m.ops + m.warmup;
  if (measured <= 0 && duration !== undefined) {
    // Duration-driven: integrate the offered rate over the window. For a ramp
    // that is the average of its endpoints, not its peak.
    const avgRate = plan.modeSpec
      ? (plan.modeSpec.fromRate + plan.modeSpec.toRate) / 2
      : (m.rate ?? 0);
    measured = Math.round(avgRate * (duration / 1000));
  }
  return plan.setupCommands + measured;
}
