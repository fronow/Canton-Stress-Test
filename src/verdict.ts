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

export function formatVerdict(c: VerdictContext): string {
  const { summary: s } = c;
  const noun = c.noun ?? "operations";
  const rate = s.contentionRate;
  const lines: string[] = [];

  const rule = "  " + "─".repeat(52);
  lines.push(rule, "");

  // --- VERDICT -------------------------------------------------------------
  lines.push(`  VERDICT   ${one(s.throughputPerSec)} ${noun}/second`);
  if (rate >= NEGLIGIBLE) {
    lines.push(
      `            ${oneIn(rate)} ${noun} failed and had to be retried`,
    );
  } else if (s.committed > 0) {
    lines.push(`            no contention worth fixing (${one(rate * 100)}%)`);
  }
  if (s.rejected > 0)
    lines.push(`            ${num(s.rejected)} rejected outright — not contention, check the log`);

  // --- WHY -----------------------------------------------------------------
  const hot = blamed(c.instrumentation);
  const losses = hot.reduce((n, h) => n + h.contention, 0);
  if (rate >= NEGLIGIBLE && hot.length > 0 && losses >= MIN_LOSSES) {
    const top = hot[0];
    // An argument contract is only ever seen as an id, so its template comes
    // from the caller or not at all.
    const tpl = (top.template.split(":").pop() || c.subject) ?? "";
    lines.push("");
    if (top.role === "argument") {
      // Contracts passed IN to the choice lost the races, not the contract the
      // choice was exercised on. That is the wallet picking a stale input, and
      // it is a property of the caller, not of the registry.
      //
      // The count reported is the run's TOTAL contention, not the sum over the
      // ranked contracts: that list is truncated, and quoting its subtotal
      // beside a much larger "dominant failure" count reads as a discrepancy.
      const where = tpl ? `${tpl}, ` : "";
      lines.push(`  WHY       Input selection, not the registry.`);
      lines.push(`            The wallet reached for holdings it had`);
      lines.push(`            already spent. (${where}${num(s.contention)} collisions)`);
    } else {
      lines.push(`  WHY       One contract is serialising the run.`);
      lines.push(`            ${tpl} lost ${num(top.contention)} of`);
      lines.push(`            ${num(top.contention + top.committed)} races it took part in.`);
    }
    if (c.instrumentation?.failureMode)
      lines.push(`            Dominant failure: ${c.instrumentation.failureMode}`);
  }

  // --- FIX -----------------------------------------------------------------
  // Only offered when the pool is known, because every number on this line is
  // derived from it.
  if (rate >= NEGLIGIBLE && c.pool !== undefined && c.pool > 0) {
    const ops = s.ops;
    const inputs = c.inputs ?? 1;
    const target5 = poolForTarget({ ops, target: 0.05, inputs });
    // Each remedy is an action and the result it buys, so they are laid out as
    // two columns and the arrows line up.
    const fixes: [string, string][] = [];
    if (target5 !== undefined && target5 > c.pool)
      fixes.push([`Hold ${num(target5)} instead of ${num(c.pool)}`, "under 5%"]);
    else if (target5 !== undefined)
      fixes.push([`The pool is already big enough`, "under 5%"]);
    // Reservation is not a prediction — it was measured at zero, at every
    // concurrency tried.
    fixes.push([`Reserve an input per submission`, "0% (measured)"]);
    if (fixes.length) {
      const w = Math.max(...fixes.map(([a]) => a.length));
      lines.push("");
      fixes.forEach(([action, result], i) => {
        lines.push(`  ${i === 0 ? "FIX     " : "        "}  ${action.padEnd(w)}  → ${result}`);
      });
    }
    if (inputs > 1)
      lines.push(
        `            Each ${noun.replace(/s$/, "")} gathers ${inputs} holdings, so it fails if`,
        `            any one of them is stale — that is why the pool`,
        `            has to be far larger than ${num(ops * inputs)}.`,
      );
  }

  lines.push("", rule);
  lines.push(
    `  Latency  p50 ${num(s.latency.p50)}ms · p99 ${num(s.latency.p99)}ms · slowest ${one(s.latency.max / 1000)}s`,
  );
  return lines.join("\n");
}
