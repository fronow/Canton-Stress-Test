// Canton-specific instrumentation (roadmap S4) — the differentiation.
//
// A generic load tool (k6, JMeter, Gatling) can tell you "p99 is 2s and 30% of
// requests failed". It cannot tell you the three things that actually decide
// whether a Canton app scales:
//
//   1. WHICH contract is serializing you. A global contention rate says a race
//      is happening; a hotspot table says the registry contract lost 40 races
//      and everything else lost none. That is the difference between "slow" and
//      "here is the line to change".
//   2. WHOSE latency it is. Every party sees its own projection, so one party
//      fronting a hot contract can carry the whole tail while the global p50
//      looks fine.
//   3. WHAT IT COSTS. Canton meters traffic (CIP-0104), so load has a price per
//      throughput level — a number no generic tool has any notion of.
//
// Everything here is pure aggregation over OpResult[], so it is fully testable
// without a ledger.

import type { OpResult, Outcome } from "./metrics.ts";
import { percentile } from "./metrics.ts";
import { dominantFailure } from "./timeseries.ts";

// ---- shared shape ----------------------------------------------------------

export interface OutcomeCounts {
  ops: number;
  committed: number;
  contention: number;
  rejected: number;
}

export interface LatencySlice extends OutcomeCounts {
  /** What this slice is keyed by (a contract id, a party, a template:choice). */
  key: string;
  contentionRate: number;
  p50: number;
  p99: number;
  maxMs: number;
}

function tally(results: OpResult[]): OutcomeCounts {
  const n = (o: Outcome) => results.filter((r) => r.outcome === o).length;
  return {
    ops: results.length,
    committed: n("committed"),
    contention: n("contention"),
    rejected: n("rejected"),
  };
}

function slice(key: string, results: OpResult[]): LatencySlice {
  const lat = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const t = tally(results);
  return {
    key,
    ...t,
    contentionRate: t.ops > 0 ? t.contention / t.ops : 0,
    p50: percentile(lat, 50),
    p99: percentile(lat, 99),
    maxMs: lat.length > 0 ? lat[lat.length - 1] : 0,
  };
}

/** Group results by a key function (skipping ops with no key) and summarize
 * each group, ordered by the comparator. */
function groupBy(
  results: OpResult[],
  keyOf: (r: OpResult) => string | string[] | undefined,
): LatencySlice[] {
  const groups = new Map<string, OpResult[]>();
  for (const r of results) {
    const k = keyOf(r);
    if (k === undefined) continue;
    for (const key of Array.isArray(k) ? k : [k]) {
      const g = groups.get(key);
      if (g) g.push(r);
      else groups.set(key, [r]);
    }
  }
  return [...groups.entries()].map(([k, rs]) => slice(k, rs));
}

// ---- 1. hot contracts ------------------------------------------------------

export interface Hotspot extends LatencySlice {
  template: string;
  /** How this contract was involved: exercised on, or passed as an argument. */
  role: "target" | "argument";
  /** Touched by nearly every operation in the run.
   *
   * A contract every operation touches has a contention rate equal to the
   * run's overall rate, so it carries no information about WHERE the conflict
   * is — it is merely popular. A Token-Standard factory is the archetype: it
   * is nonconsuming and cannot conflict at all, yet naive ranking puts it top
   * because it appears everywhere. Ubiquitous contracts are reported but
   * excluded from the bottleneck verdict. */
  ubiquitous: boolean;
}

/** Only a contract present in essentially EVERY operation is discounted.
 * Deliberately strict: a contract in 90% of operations may well be a genuine
 * bottleneck, and demoting it would hide the very thing being looked for. */
const UBIQUITY = 0.99;

/** Contracts ranked by how many races they LOST. A hot contract is one many
 * operations funnel through: it serializes, so its contention count towers over
 * everything else's. Ranked by contention first, then by attempts — a contract
 * touched often but never contended is not a hotspot, it is just popular. */
export function hotContracts(results: OpResult[], limit = 10): Hotspot[] {
  const templateOf = new Map<string, string>();
  const roleOf = new Map<string, "target" | "argument">();
  for (const r of results) {
    const a = r.attribution;
    if (!a) continue;
    if (a.contractId) {
      templateOf.set(a.contractId, a.template);
      roleOf.set(a.contractId, "target");
    }
    // Arguments too: in a factory-shaped app these are the contracts that
    // actually get archived, so this is where the conflict really is.
    for (const c of a.argumentContractIds ?? []) {
      if (!roleOf.has(c)) roleOf.set(c, "argument");
      if (!templateOf.has(c)) templateOf.set(c, "");
    }
  }

  return groupBy(results, (r) => {
    const a = r.attribution;
    if (!a) return undefined;
    const args = a.argumentContractIds ?? [];
    // An operation is counted against every contract it touched. A factory
    // exercised by every op would otherwise dominate purely by frequency.
    return a.contractId ? [a.contractId, ...args] : args;
  })
    .map((s, _i, all) => ({
      ...s,
      template: templateOf.get(s.key) ?? "",
      role: roleOf.get(s.key) ?? ("target" as const),
      // Only a discount when there is something to discount it AGAINST. If the
      // run touches a single contract, that contract is the finding, not
      // noise — a deliberate hot-contract probe is exactly that shape.
      ubiquitous:
        all.length > 1 && results.length > 0 && s.ops >= results.length * UBIQUITY,
    }))
    // Informative contracts first, then by races lost.
    .sort(
      (a, b) =>
        Number(a.ubiquitous) - Number(b.ubiquitous) ||
        b.contention - a.contention ||
        b.ops - a.ops,
    )
    .slice(0, limit);
}

/** How concentrated the contention is: the share carried by the single worst
 * contract. Near 1 means one contract is the bottleneck (fix that one); near 0
 * with high contention means broad, structural contention. Undefined when
 * nothing contended. */
export function contentionConcentration(results: OpResult[]): number | undefined {
  const total = results.filter((r) => r.outcome === "contention").length;
  if (total === 0) return undefined;
  // Ubiquitous contracts are excluded: "the contract every operation touches
  // carries all the contention" is true by construction and says nothing.
  const worst = hotContracts(results, Infinity).find((h) => !h.ubiquitous);
  return worst ? worst.contention / total : undefined;
}

// ---- 2. per-party and per-operation ----------------------------------------

/** Latency and outcomes per submitting party. An op submitted by several
 * parties counts for each of them. */
export function byParty(results: OpResult[]): LatencySlice[] {
  return groupBy(results, (r) => r.attribution?.parties).sort((a, b) => b.p99 - a.p99);
}

/** Latency and outcomes per operation kind ("Template:Choice" / "Template:create"). */
export function byOperation(results: OpResult[]): LatencySlice[] {
  return groupBy(results, (r) => {
    const a = r.attribution;
    return a ? `${shortTemplate(a.template)}:${a.choice ?? "create"}` : undefined;
  }).sort((a, b) => b.ops - a.ops);
}

const shortTemplate = (t: string): string => {
  const parts = t.split(":");
  return parts.length >= 3 ? parts.slice(-2).join(":") : t;
};

// ---- 3. read-side lag ------------------------------------------------------

export interface LagSample {
  /** ms since the run started. */
  atMs: number;
  /** How far the read path trailed the write path, in ledger offsets. */
  offsetLag: number;
  /** Wall time for the read-path query itself. */
  queryMs: number;
}

export interface ReadLagReport {
  samples: number;
  maxOffsetLag: number;
  meanOffsetLag: number;
  p99QueryMs: number;
  maxQueryMs: number;
}

/** Summarize read-path staleness under write load. On Canton the read side
 * (indexer, and downstream PQS/Scribe) is a separate stage from the write
 * path, so it can fall behind while commits still look healthy — a lag that
 * only shows up under sustained load, and that breaks read-your-writes for
 * anything querying the ACS. */
export function summarizeLag(samples: LagSample[]): ReadLagReport | undefined {
  if (samples.length === 0) return undefined;
  const lags = samples.map((s) => s.offsetLag);
  const q = samples.map((s) => s.queryMs).sort((a, b) => a - b);
  return {
    samples: samples.length,
    maxOffsetLag: Math.max(...lags),
    meanOffsetLag: lags.reduce((a, b) => a + b, 0) / lags.length,
    p99QueryMs: percentile(q, 99),
    maxQueryMs: q[q.length - 1],
  };
}

// ---- 4. traffic cost (CIP-0104) -------------------------------------------

export interface TrafficEstimate {
  /** "Template:Choice" this estimate is for. */
  operation: string;
  confirmationRequest: number;
  confirmationResponse: number;
  total: number;
  /** Prepared-transaction size in bytes — measurable without traffic control.
   * See TrafficCost.preparedBytes for what it is and is not. */
  preparedBytes?: number;
}

export interface TrafficReport {
  /** Per-operation estimates, sampled once each before the measured window. */
  perOperation: TrafficEstimate[];
  /** Traffic units for the whole measured window (estimate × committed ops). */
  totalForRun: number;
  /** Traffic units per second at the achieved throughput. */
  perSecond: number;
  /** True when the synchronizer reported no cost at all — a sandbox without
   * traffic control is UNMETERED, and reporting "0" as if it were a measured
   * cost would be a lie. */
  unmetered: boolean;
  /** Prepared-transaction bytes across all committed operations. Present even
   * when the run is unmetered, which is the point: envelope size is measurable
   * on any participant, while the CIP-0104 cost is not. */
  preparedBytesForRun?: number;
  /** Mean prepared bytes per committed operation. */
  preparedBytesPerOp?: number;
  /** Cost of `preparedBytesForRun` at the configured price, in USD. */
  estimatedCostUsd?: number;
  /** Cost per committed operation, in USD. */
  costPerOpUsd?: number;
  /** The price used, in USD per megabyte. Reported so the figure above can
   * never be quoted without the assumption that produced it. */
  usdPerMb?: number;
}

/** Combine per-operation cost estimates with what the run actually committed. */
export function summarizeTraffic(
  estimates: TrafficEstimate[],
  results: OpResult[],
  wallMs: number,
  usdPerMb?: number,
): TrafficReport | undefined {
  if (estimates.length === 0) return undefined;
  const byOp = new Map(estimates.map((e) => [e.operation, e]));
  let totalForRun = 0;
  let preparedForRun = 0;
  let committed = 0;
  let sawPrepared = false;
  for (const r of results) {
    // Only committed transactions are actually sequenced, so only they cost.
    if (r.outcome !== "committed" || !r.attribution) continue;
    const key = `${shortTemplate(r.attribution.template)}:${r.attribution.choice ?? "create"}`;
    const e = byOp.get(key);
    totalForRun += e?.total ?? 0;
    if (e?.preparedBytes !== undefined) {
      preparedForRun += e.preparedBytes;
      sawPrepared = true;
    }
    committed++;
  }
  const secs = wallMs / 1000;
  const report: TrafficReport = {
    perOperation: estimates,
    totalForRun,
    perSecond: secs > 0 ? totalForRun / secs : 0,
    unmetered: estimates.every((e) => e.total === 0),
  };
  if (sawPrepared) {
    report.preparedBytesForRun = preparedForRun;
    report.preparedBytesPerOp = committed > 0 ? preparedForRun / committed : 0;
    // Pricing is opt-in. Without a price there is a size and no dollar figure,
    // because the price varies by network and inventing a default would put an
    // unsourced number in a report people quote.
    if (usdPerMb !== undefined && usdPerMb > 0) {
      const mb = preparedForRun / (1024 * 1024);
      report.usdPerMb = usdPerMb;
      report.estimatedCostUsd = mb * usdPerMb;
      report.costPerOpUsd = committed > 0 ? (mb * usdPerMb) / committed : 0;
    }
  }
  return report;
}

// ---- the S4 block as a whole ----------------------------------------------

export interface Instrumentation {
  hotspots: Hotspot[];
  contentionConcentration?: number;
  byParty: LatencySlice[];
  byOperation: LatencySlice[];
  readLag?: ReadLagReport;
  traffic?: TrafficReport;
  /** Synchronizer the run was driven against, when the participant reports one. */
  synchronizerId?: string;
  /** The failure that dominated the run, e.g. "CONTRACT_NOT_FOUND (28×)".
   * A contention RATE says a race happened; the code says what kind — a stale
   * contract reference and a lock conflict call for different fixes. */
  failureMode?: string;
}

export function instrument(o: {
  results: OpResult[];
  wallMs: number;
  lagSamples?: LagSample[];
  trafficEstimates?: TrafficEstimate[];
  synchronizerId?: string;
  hotspotLimit?: number;
  /** Price for envelope bytes, USD per megabyte. Omitted means report size
   * only — see summarizeTraffic for why there is no default. */
  usdPerMb?: number;
}): Instrumentation {
  return {
    hotspots: hotContracts(o.results, o.hotspotLimit ?? 10),
    contentionConcentration: contentionConcentration(o.results),
    byParty: byParty(o.results),
    byOperation: byOperation(o.results),
    readLag: summarizeLag(o.lagSamples ?? []),
    traffic: summarizeTraffic(o.trafficEstimates ?? [], o.results, o.wallMs, o.usdPerMb),
    synchronizerId: o.synchronizerId,
    failureMode: o.results.some((r) => r.outcome !== "committed")
      ? dominantFailure(o.results)
      : undefined,
  };
}

/** Human-readable S4 block for the console. */
export function formatInstrumentation(i: Instrumentation): string {
  const r1 = (n: number) => Math.round(n * 10) / 10;
  const kb = (b: number) => (b < 1024 ? `${Math.round(b)} B` : `${r1(b / 1024)} KB`);
  const out: string[] = [];

  if (i.failureMode && i.failureMode !== "none")
    out.push(`  dominant failure: ${i.failureMode}`);

  const contended = i.hotspots.filter((h) => h.contention > 0);
  if (contended.length > 0) {
    out.push("  hot contracts (contention by contract):");
    for (const h of contended.slice(0, 5))
      out.push(
        `    ${h.key.slice(0, 12)}… ${shortTemplate(h.template) || h.role}  ` +
          `${h.contention}/${h.ops} lost (${r1(h.contentionRate * 100)}%)  p99 ${r1(h.p99)}ms` +
          (h.ubiquitous ? "  [in every op — carries no signal]" : ""),
      );
    if (i.contentionConcentration !== undefined) {
      // With only a handful of losses any single contract holds a large share
      // by arithmetic, so the bottleneck call needs a sample behind it.
      const totalContention = contended.reduce((n, h) => n + h.contention, 0);
      const enough = totalContention >= 10;
      out.push(
        `    concentration: ${r1(i.contentionConcentration * 100)}% of all contention on one contract` +
          (i.contentionConcentration >= 0.5 && enough
            ? "  ← single bottleneck"
            : enough
              ? ""
              : "  (too few losses to call a bottleneck)"),
      );
    }
  }

  if (i.byOperation.length > 1) {
    out.push("  by operation:");
    for (const s of i.byOperation)
      out.push(`    ${s.key}  ${s.ops} ops, ${r1(s.contentionRate * 100)}% contention, p99 ${r1(s.p99)}ms`);
  }

  if (i.byParty.length > 1) {
    const worst = i.byParty[0];
    const best = i.byParty[i.byParty.length - 1];
    out.push(
      `  per-party latency spread: p99 ${r1(worst.p99)}ms (worst) … ${r1(best.p99)}ms (best) ` +
        `across ${i.byParty.length} parties`,
    );
  }

  if (i.readLag)
    out.push(
      `  read-side lag: max ${i.readLag.maxOffsetLag} offsets behind, ` +
        `mean ${r1(i.readLag.meanOffsetLag)}; ACS query p99 ${r1(i.readLag.p99QueryMs)}ms`,
    );

  if (i.traffic) {
    out.push(
      i.traffic.unmetered
        ? "  traffic cost: UNMETERED on this synchronizer (no traffic control configured — a sandbox reports 0)"
        : `  traffic cost: ${i.traffic.totalForRun} units for the run, ${r1(i.traffic.perSecond)}/s`,
    );
    // Envelope size is measurable even when the cost is not, which is the whole
    // reason it is reported separately from the CIP-0104 figure above.
    const t = i.traffic;
    if (t.preparedBytesPerOp !== undefined) {
      out.push(
        `  envelope size: ${kb(t.preparedBytesPerOp)} per operation, ` +
          `${kb(t.preparedBytesForRun ?? 0)} for the run`,
      );
      if (t.costPerOpUsd !== undefined)
        out.push(
          `    at $${t.usdPerMb}/MB: $${t.costPerOpUsd.toFixed(4)} per operation, ` +
            `$${(t.estimatedCostUsd ?? 0).toFixed(2)} for the run`,
        );
      out.push(
        "    (prepared-transaction size — a lower bound: the sequenced request also",
        "     carries encrypted views per informee, so the metered figure is larger)",
      );
    }
  }

  return out.join("\n");
}
