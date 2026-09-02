// The answer, rather than the measurements.
//
// A load test that reports percentiles has told the user what happened and left
// them to work out what it means. This block states the finding, names the
// cause, and gives the remedy — with the distribution still printed underneath
// for anyone who wants to check the working.
//
// The FIX line is only possible because contention has a model (contention.ts):
// that is what turns "20.4% contention" into "hold 2,400 instead of 480". A
// general-purpose load generator cannot say this, because it does not know what
// a holding is.
//
// Every claim here degrades to silence rather than to a guess. No pool size, no
// FIX line. Too few losses to attribute, no WHY line. This follows the rule the
// analysis modules already use: an analysis returns nothing when the data does
// not support a conclusion.

import type { Summary } from "./metrics.ts";
import type { Instrumentation, Hotspot } from "./instrument.ts";
import { poolForTarget } from "./contention.ts";

export interface VerdictContext {
  summary: Summary;
  instrumentation?: Instrumentation;
  /** Holdings the sending wallet could spend from, when the run knows it —
   * which an auto-planned run does. Without it there is no FIX arithmetic. */
  pool?: number;
  /** Holdings gathered per operation. */
  inputs?: number;
  /** What one operation is, in prose. */
  noun?: string;
  /** The template whose contracts are being spent, when the caller knows it.
   * Contracts passed as ARGUMENTS are seen only as ids — the run never learns
   * their template — so without this the cause cannot be named. */
  subject?: string;
}

/** Below this, contention is not the story and a FIX would be noise. */
const NEGLIGIBLE = 0.01;
/** Attribution needs enough losses to mean something (matches instrument.ts). */
const MIN_LOSSES = 10;

const num = (n: number): string => Math.round(n).toLocaleString("en-US");
const one = (n: number): string => Math.round(n * 10) / 10 + "";

/** "1 in 5" — the form people reason about, rather than a percentage. */
function oneIn(rate: number): string {
  if (rate <= 0) return "none";
  return `1 in ${Math.max(2, Math.round(1 / rate))}`;
}

/** The contracts that actually lost races, ignoring the merely popular. */
function blamed(inst: Instrumentation | undefined): Hotspot[] {
  return (inst?.hotspots ?? []).filter((h) => !h.ubiquitous && h.contention > 0);
}

/** The verdict as data, so the terminal and the HTML report render one decision
 * rather than each making their own and drifting apart. */
export interface VerdictModel {
  noun: string;
  throughput: string;
  /** "1 in 5 transfers failed…" or the negligible-contention line. */
  headline?: string;
  /** Rejections are not contention and need a different fix. */
  rejected?: string;
  why?: {
    /** "Input selection, not the registry." */
    title: string;
    detail: string;
    failureMode?: string;
  };
  /** Remedy and the result it buys. */
  fixes: { action: string; result: string }[];
  /** Why a multi-input pool must be larger than the naive arithmetic suggests. */
  fixNote?: string;
  latency: { p50: string; p99: string; max: string };
}

/** Decide the verdict. Returns the model; formatting is the caller's business. */
export function computeVerdict(c: VerdictContext): VerdictModel {
  const { summary: s } = c;
  const noun = c.noun ?? "operations";
  const rate = s.contentionRate;

  const m: VerdictModel = {
    noun,
    throughput: `${one(s.throughputPerSec)} ${noun}/second`,
    fixes: [],
    latency: {
      p50: `${num(s.latency.p50)}ms`,
      p99: `${num(s.latency.p99)}ms`,
      max: `${one(s.latency.max / 1000)}s`,
    },
  };

  if (rate >= NEGLIGIBLE) m.headline = `${oneIn(rate)} ${noun} failed and had to be retried`;
  else if (s.committed > 0) m.headline = `no contention worth fixing (${one(rate * 100)}%)`;
  if (s.rejected > 0)
    m.rejected = `${num(s.rejected)} rejected outright — not contention, check the log`;

  const hot = blamed(c.instrumentation);
  const losses = hot.reduce((n, h) => n + h.contention, 0);
  if (rate >= NEGLIGIBLE && hot.length > 0 && losses >= MIN_LOSSES) {
    const top = hot[0];
    // An argument contract is only ever seen as an id, so its template comes
    // from the caller or not at all.
    const tpl = (top.template.split(":").pop() || c.subject) ?? "";
    if (top.role === "argument") {
      // Contracts passed IN to the choice lost the races, not the contract the
      // choice was exercised on. That is the caller picking a stale input, and
      // it is a property of the wallet, not of the registry.
      //
      // The count reported is the run's TOTAL contention, not the sum over the
      // ranked contracts: that list is truncated, and quoting its subtotal
      // beside a much larger "dominant failure" count reads as a discrepancy.
      m.why = {
        title: "Input selection, not the registry.",
        detail:
          `The wallet reached for holdings it had already spent. ` +
          `(${tpl ? `${tpl}, ` : ""}${num(s.contention)} collisions)`,
        failureMode: c.instrumentation?.failureMode,
      };
    } else {
      m.why = {
        title: "One contract is serialising the run.",
        detail: `${tpl} lost ${num(top.contention)} of ${num(top.contention + top.committed)} races it took part in.`,
        failureMode: c.instrumentation?.failureMode,
      };
    }
  }

  // Only offered when the pool is known, because every number here derives
  // from it.
  if (rate >= NEGLIGIBLE && c.pool !== undefined && c.pool > 0) {
    const ops = s.ops;
    const inputs = c.inputs ?? 1;
    const target5 = poolForTarget({ ops, target: 0.05, inputs });
    if (target5 !== undefined && target5 > c.pool)
      m.fixes.push({ action: `Hold ${num(target5)} instead of ${num(c.pool)}`, result: "under 5%" });
    else if (target5 !== undefined)
      m.fixes.push({ action: "The pool is already big enough", result: "under 5%" });
    // Reservation is not a prediction — it was measured at zero, at every
    // concurrency tried.
    m.fixes.push({ action: "Reserve an input per submission", result: "0% (measured)" });
    if (inputs > 1)
      m.fixNote =
        `Each ${noun.replace(/s$/, "")} gathers ${inputs} holdings, so it fails if any one of them ` +
        `is stale — that is why the pool has to be far larger than ${num(ops * inputs)}.`;
  }

  return m;
}

export function formatVerdict(c: VerdictContext): string {
  const m = computeVerdict(c);
  const lines: string[] = [];
  const rule = "  " + "─".repeat(52);
  lines.push(rule, "");

  lines.push(`  VERDICT   ${m.throughput}`);
  if (m.headline) lines.push(`            ${m.headline}`);
  if (m.rejected) lines.push(`            ${m.rejected}`);

  if (m.why) {
    lines.push("");
    lines.push(`  WHY       ${m.why.title}`);
    for (const l of wrap(m.why.detail, 44)) lines.push(`            ${l}`);
    if (m.why.failureMode) lines.push(`            Dominant failure: ${m.why.failureMode}`);
  }

  if (m.fixes.length > 0) {
    // Each remedy is an action and the result it buys, laid out as two columns
    // so the arrows line up.
    const w = Math.max(...m.fixes.map((f) => f.action.length));
    lines.push("");
    m.fixes.forEach((f, i) => {
      lines.push(`  ${i === 0 ? "FIX     " : "        "}  ${f.action.padEnd(w)}  → ${f.result}`);
    });
    if (m.fixNote) for (const l of wrap(m.fixNote, 44)) lines.push(`            ${l}`);
  }

  lines.push("", rule);
  lines.push(`  Latency  p50 ${m.latency.p50} · p99 ${m.latency.p99} · slowest ${m.latency.max}`);
  return lines.join("\n");
}

/** Greedy wrap, so a long detail line does not run off a terminal. */
function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line.length > 0 && line.length + 1 + word.length > width) {
      out.push(line);
      line = word;
    } else line = line.length > 0 ? `${line} ${word}` : word;
  }
  if (line.length > 0) out.push(line);
  return out;
}
