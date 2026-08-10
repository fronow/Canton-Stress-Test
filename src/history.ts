// Performance history across runs (roadmap M3).
//
// A single-baseline gate ("compare to last week's run") is the obvious design
// and it flaps: one unlucky baseline poisons every comparison until somebody
// re-records it, and teams respond by widening the threshold until the gate
// stops meaning anything.
//
// Comparing against the ROLLING MEDIAN of recent runs is robust to exactly
// that. A median is unmoved by one bad run, so a real regression still shows
// and a noisy afternoon does not. It also lets the tool answer the question a
// single comparison cannot: is this drifting over months?
//
// Storage is JSON Lines — append-only, one run per line. Cheap to append,
// readable in a diff, and a corrupt line loses one run rather than the file.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { LoadReport } from "./load.ts";

export interface HistoryEntry {
  /** ISO timestamp of the run. */
  at: string;
  runId: string;
  /** Free-form marker — a commit sha, a branch, a release. */
  label?: string;
  model: "closed" | "open";
  ops: number;
  committed: number;
  throughputPerSec: number;
  p50Ms: number;
  p99Ms: number;
  contentionRate: number;
}

export function toHistoryEntry(
  report: LoadReport,
  o: { runId: string; label?: string; at?: Date },
): HistoryEntry {
  const s = report.summary;
  return {
    at: (o.at ?? new Date()).toISOString(),
    runId: o.runId,
    label: o.label,
    model: report.model,
    ops: s.ops,
    committed: s.committed,
    throughputPerSec: s.throughputPerSec,
    p50Ms: s.latency.p50,
    p99Ms: s.latency.p99,
    contentionRate: s.contentionRate,
  };
}

export function appendHistory(path: string, entry: HistoryEntry): void {
  appendFileSync(path, JSON.stringify(entry) + "\n");
}

/** Read a history file, skipping malformed lines rather than failing.
 * A history is an audit trail: one unreadable line must not make the other
 * three hundred runs unusable. */
export function loadHistory(path: string): HistoryEntry[] {
  if (!existsSync(path)) return [];
  const out: HistoryEntry[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t) as HistoryEntry;
      if (typeof e.throughputPerSec === "number" && typeof e.p99Ms === "number") out.push(e);
    } catch {
      /* skip */
    }
  }
  return out;
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export interface TrendReport {
  /** Runs the comparison is against (excludes the current one). */
  baselineRuns: number;
  medianThroughput: number;
  medianP99Ms: number;
  /** Percent change of the current run against those medians. */
  throughputChangePct: number;
  p99ChangePct: number;
  /** Direction over the whole history, from first third to last third. */
  driftThroughputPct?: number;
  driftP99Pct?: number;
}

/** Compare the latest run against the median of the preceding `window` runs. */
export function summarizeTrend(history: HistoryEntry[], window = 10): TrendReport | undefined {
  if (history.length < 2) return undefined;
  const current = history[history.length - 1];
  const prior = history.slice(Math.max(0, history.length - 1 - window), history.length - 1);
  if (prior.length === 0) return undefined;

  const medThr = median(prior.map((e) => e.throughputPerSec));
  const medP99 = median(prior.map((e) => e.p99Ms));

  const report: TrendReport = {
    baselineRuns: prior.length,
    medianThroughput: medThr,
    medianP99Ms: medP99,
    throughputChangePct: medThr > 0 ? (current.throughputPerSec / medThr - 1) * 100 : 0,
    p99ChangePct: medP99 > 0 ? (current.p99Ms / medP99 - 1) * 100 : 0,
  };

  // Long-run drift needs enough history to have a first and last third that
  // are not the same runs.
  if (history.length >= 6) {
    const third = Math.floor(history.length / 3);
    const first = history.slice(0, third);
    const last = history.slice(-third);
    const f = median(first.map((e) => e.throughputPerSec));
    const l = median(last.map((e) => e.throughputPerSec));
    const fp = median(first.map((e) => e.p99Ms));
    const lp = median(last.map((e) => e.p99Ms));
    report.driftThroughputPct = f > 0 ? (l / f - 1) * 100 : 0;
    report.driftP99Pct = fp > 0 ? (lp / fp - 1) * 100 : 0;
  }
  return report;
}

export interface TrendThresholds {
  /** Fail if throughput is more than this percent below the rolling median. */
  maxThroughputDropPct?: number;
  /** Fail if p99 is more than this percent above the rolling median. */
  maxP99RisePct?: number;
}

export function checkTrend(
  trend: TrendReport | undefined,
  t: TrendThresholds,
): { pass: boolean; failures: string[] } {
  const failures: string[] = [];
  if (!trend) return { pass: true, failures };
  const r1 = (n: number) => Math.round(n * 10) / 10;

  if (t.maxThroughputDropPct !== undefined && -trend.throughputChangePct > t.maxThroughputDropPct)
    failures.push(
      `throughput ${r1(-trend.throughputChangePct)}% below the median of the last ` +
        `${trend.baselineRuns} runs (${r1(trend.medianThroughput)}/s; max drop ${t.maxThroughputDropPct}%)`,
    );
  if (t.maxP99RisePct !== undefined && trend.p99ChangePct > t.maxP99RisePct)
    failures.push(
      `p99 ${r1(trend.p99ChangePct)}% above the median of the last ${trend.baselineRuns} runs ` +
        `(${r1(trend.medianP99Ms)}ms; max rise ${t.maxP99RisePct}%)`,
    );
  return { pass: failures.length === 0, failures };
}

const r1 = (n: number): number => Math.round(n * 10) / 10;
const signed = (n: number): string => `${n >= 0 ? "+" : ""}${r1(n)}%`;

export function formatTrend(trend: TrendReport | undefined, history: HistoryEntry[]): string {
  if (!trend) return `  history: ${history.length} run(s) — need at least 2 to compare`;
  const out = [
    `  vs median of last ${trend.baselineRuns} run(s): ` +
      `throughput ${signed(trend.throughputChangePct)} (median ${r1(trend.medianThroughput)}/s), ` +
      `p99 ${signed(trend.p99ChangePct)} (median ${r1(trend.medianP99Ms)}ms)`,
  ];
  if (trend.driftThroughputPct !== undefined)
    out.push(
      `  drift over ${history.length} runs: throughput ${signed(trend.driftThroughputPct)}, ` +
        `p99 ${signed(trend.driftP99Pct ?? 0)}`,
    );
  return out.join("\n");
}
