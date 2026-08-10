// CI gating (roadmap S7). Pure pass/fail checks so a load run can fail a build:
//   - checkSla: absolute thresholds (min throughput, max p99, max contention)
//   - checkRegression: relative to a saved baseline (throughput drop, p99 rise)
// Both return the failing reasons so the CLI can print them and exit non-zero.

import type { Instrumentation } from "./instrument.ts";
import type { Summary } from "./metrics.ts";

const r1 = (n: number): number => Math.round(n * 10) / 10;

export interface GateResult {
  pass: boolean;
  failures: string[];
}

export interface SlaThresholds {
  /** Floor for committed transactions per second. */
  minThroughput?: number;
  /** Ceiling for p99 latency, in ms. */
  maxP99Ms?: number;
  /** Ceiling for contention rate, in percent. */
  maxContentionPct?: number;
  /** [S4] Ceiling for the share of ALL contention carried by a single contract,
   * in percent. Catches the regression that funnels a workload through one new
   * bottleneck even when the overall contention rate still looks acceptable. */
  maxHotspotSharePct?: number;
  /** [S4] Ceiling for how far the read path may trail the write path, in
   * ledger offsets. */
  maxReadLagOffsets?: number;
}

export function checkSla(s: Summary, t: SlaThresholds, i?: Instrumentation): GateResult {
  const failures: string[] = [];
  if (t.minThroughput !== undefined && s.throughputPerSec < t.minThroughput)
    failures.push(`throughput ${r1(s.throughputPerSec)}/s below min ${t.minThroughput}/s`);
  if (t.maxP99Ms !== undefined && s.latency.p99 > t.maxP99Ms)
    failures.push(`p99 ${r1(s.latency.p99)}ms above max ${t.maxP99Ms}ms`);
  if (t.maxContentionPct !== undefined && s.contentionRate * 100 > t.maxContentionPct)
    failures.push(`contention ${r1(s.contentionRate * 100)}% above max ${t.maxContentionPct}%`);
  if (t.maxHotspotSharePct !== undefined && i?.contentionConcentration !== undefined) {
    const sharePct = i.contentionConcentration * 100;
    if (sharePct > t.maxHotspotSharePct) {
      const worst = i.hotspots[0];
      failures.push(
        `one contract carries ${r1(sharePct)}% of all contention (max ${t.maxHotspotSharePct}%)` +
          (worst ? ` — ${worst.template} ${worst.key.slice(0, 12)}…` : ""),
      );
    }
  }
  if (t.maxReadLagOffsets !== undefined && i?.readLag !== undefined) {
    if (i.readLag.maxOffsetLag > t.maxReadLagOffsets)
      failures.push(
        `read-side lag ${i.readLag.maxOffsetLag} offsets above max ${t.maxReadLagOffsets}`,
      );
  }
  return { pass: failures.length === 0, failures };
}

export interface RegressionThresholds {
  /** Fail if throughput dropped more than this percent vs the baseline. */
  maxThroughputDropPct?: number;
  /** Fail if p99 latency rose more than this percent vs the baseline. */
  maxP99RisePct?: number;
}

export function checkRegression(
  current: Summary,
  baseline: Summary,
  t: RegressionThresholds,
): GateResult {
  const failures: string[] = [];
  if (t.maxThroughputDropPct !== undefined && baseline.throughputPerSec > 0) {
    const dropPct = (1 - current.throughputPerSec / baseline.throughputPerSec) * 100;
    if (dropPct > t.maxThroughputDropPct)
      failures.push(
        `throughput dropped ${r1(dropPct)}% (${r1(current.throughputPerSec)}/s vs baseline ${r1(baseline.throughputPerSec)}/s; max ${t.maxThroughputDropPct}%)`,
      );
  }
  if (t.maxP99RisePct !== undefined && baseline.latency.p99 > 0) {
    const risePct = (current.latency.p99 / baseline.latency.p99 - 1) * 100;
    if (risePct > t.maxP99RisePct)
      failures.push(
        `p99 rose ${r1(risePct)}% (${r1(current.latency.p99)}ms vs baseline ${r1(baseline.latency.p99)}ms; max ${t.maxP99RisePct}%)`,
      );
  }
  return { pass: failures.length === 0, failures };
}
