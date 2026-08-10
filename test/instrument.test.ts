import assert from "node:assert/strict";
import { test } from "node:test";
import { checkSla } from "../src/gate.ts";
import {
  byOperation,
  byParty,
  contentionConcentration,
  formatInstrumentation,
  hotContracts,
  instrument,
  summarizeLag,
  summarizeTraffic,
  type LagSample,
} from "../src/instrument.ts";
import { classifyOutcome, type OpResult, type Outcome } from "../src/metrics.ts";

const op = (
  outcome: Outcome,
  latencyMs: number,
  a: {
    template?: string;
    choice?: string;
    contractId?: string;
    argumentContractIds?: string[];
    parties?: string[];
  } = {},
): OpResult => ({
  outcome,
  latencyMs,
  attribution: {
    template: a.template ?? "pkg:M:Holding",
    choice: a.choice,
    contractId: a.contractId,
    argumentContractIds: a.argumentContractIds,
    parties: a.parties ?? ["alice"],
  },
});

test("hotContracts ranks by races LOST, not by how often a contract is touched", () => {
  const results = [
    // A popular contract that never contends — busy, but not a hotspot.
    ...Array.from({ length: 20 }, () => op("committed", 10, { contractId: "popular" })),
    // The registry everything funnels through: few attempts, many losses.
    ...Array.from({ length: 6 }, () => op("contention", 90, { contractId: "registry" })),
    op("committed", 12, { contractId: "registry" }),
  ];
  const hot = hotContracts(results);
  assert.equal(hot[0].key, "registry");
  assert.equal(hot[0].contention, 6);
  assert.equal(hot[0].ops, 7);
  assert.equal(hot[1].key, "popular");
  assert.equal(hot[1].contention, 0);
});

test("a run through ONE shared contract still names it — ubiquity must not hide the finding", () => {
  // Regression. The ubiquity discount exists so a nonconsuming factory touched
  // by every operation is not mistaken for the bottleneck. But a deliberate
  // hot-contract probe touches exactly one contract, and there that contract
  // IS the finding — discounting it reported "carries no signal" about the
  // only thing the run had to say. Measured live: 1 committed, 39 contention,
  // and the registry flagged as noise.
  const results = [
    op("committed", 30, { contractId: "registry" }),
    ...Array.from({ length: 39 }, () => op("contention", 900, { contractId: "registry" })),
  ];
  const [hot] = hotContracts(results);
  assert.equal(hot.key, "registry");
  assert.equal(hot.contention, 39);
  assert.equal(hot.ubiquitous, false, "with nothing to compare against, the sole contract is the answer");
  assert.equal(contentionConcentration(results), 1);

  // The discount still applies when there IS something to compare against: a
  // factory in every op, plus per-holding conflicts.
  const withFactory = [
    ...Array.from({ length: 20 }, (_, i) =>
      op(i < 4 ? "contention" : "committed", 50, {
        contractId: "factory",
        argumentContractIds: [`holding${i}`],
      }),
    ),
  ];
  const ranked = hotContracts(withFactory, Infinity);
  assert.equal(ranked.find((h) => h.key === "factory")?.ubiquitous, true);
  assert.notEqual(ranked[0].key, "factory", "an in-every-op contract must not lead the ranking");
  // It sorts last precisely because it is uninformative, so a default-limited
  // table shows the contracts that actually discriminate.
  assert.equal(ranked[ranked.length - 1].key, "factory");
  assert.ok(!hotContracts(withFactory).some((h) => h.key === "factory"));
});

test("contentionConcentration separates one bottleneck from broad contention", () => {
  const oneHotspot = [
    ...Array.from({ length: 9 }, () => op("contention", 50, { contractId: "registry" })),
    op("contention", 50, { contractId: "other" }),
  ];
  assert.equal(contentionConcentration(oneHotspot), 0.9);

  // Same contention rate, spread evenly over ten contracts — a structural
  // problem, not a single line to fix.
  const spread = Array.from({ length: 10 }, (_, i) =>
    op("contention", 50, { contractId: `c${i}` }),
  );
  assert.equal(contentionConcentration(spread), 0.1);

  assert.equal(contentionConcentration([op("committed", 5)]), undefined);
});

test("byParty attributes an op to every submitting party and sorts by worst p99", () => {
  const results = [
    op("committed", 10, { parties: ["alice", "custodian"] }),
    op("committed", 900, { parties: ["bob", "custodian"] }),
  ];
  const rows = byParty(results);
  assert.deepEqual(rows.map((r) => r.key).sort(), ["alice", "bob", "custodian"]);
  // Sorted worst-p99 first; alice (10ms) is the healthy one and lands last.
  assert.equal(rows[0].p99, 900);
  assert.equal(rows[rows.length - 1].key, "alice");
  // The custodian co-submits everything, so it carries both ops — and bob's
  // 900ms tail with them.
  const custodian = rows.find((r) => r.key === "custodian")!;
  assert.equal(custodian.ops, 2);
  assert.equal(custodian.p99, 900);
  assert.equal(rows.find((r) => r.key === "bob")!.ops, 1);
});

test("byOperation keys on template:choice and shortens the template id", () => {
  const rows = byOperation([
    op("committed", 10, { template: "abc123:Settlement:Holding", choice: "Transfer" }),
    op("contention", 20, { template: "abc123:Settlement:Holding", choice: "Transfer" }),
    op("committed", 30, { template: "abc123:Settlement:Account" }),
  ]);
  assert.deepEqual(rows.map((r) => r.key), ["Settlement:Holding:Transfer", "Settlement:Account:create"]);
  assert.equal(rows[0].contentionRate, 0.5);
});

test("summarizeLag reports how far the read path trailed", () => {
  const samples: LagSample[] = [
    { atMs: 0, offsetLag: 0, queryMs: 3 },
    { atMs: 100, offsetLag: 12, queryMs: 5 },
    { atMs: 200, offsetLag: 4, queryMs: 40 },
  ];
  const lag = summarizeLag(samples)!;
  assert.equal(lag.samples, 3);
  assert.equal(lag.maxOffsetLag, 12);
  assert.equal(Math.round(lag.meanOffsetLag * 10) / 10, 5.3);
  assert.equal(lag.maxQueryMs, 40);
  assert.equal(summarizeLag([]), undefined);
});

test("summarizeTraffic charges only committed ops, and flags an unmetered synchronizer", () => {
  const estimates = [
    { operation: "M:Holding:Transfer", confirmationRequest: 300, confirmationResponse: 200, total: 500 },
    { operation: "M:Holding:Split", confirmationRequest: 60, confirmationResponse: 40, total: 100 },
  ];
  const results = [
    op("committed", 10, { template: "pkg:M:Holding", choice: "Transfer" }),
    op("committed", 10, { template: "pkg:M:Holding", choice: "Transfer" }),
    op("committed", 10, { template: "pkg:M:Holding", choice: "Split" }),
    // A rejected op is never sequenced, so it costs nothing.
    op("contention", 10, { template: "pkg:M:Holding", choice: "Transfer" }),
  ];
  const t = summarizeTraffic(estimates, results, 2000)!;
  assert.equal(t.totalForRun, 1100); // 500 + 500 + 100
  assert.equal(t.perSecond, 550); // over 2s
  assert.equal(t.unmetered, false);

  // A sandbox with no traffic control returns zeros — say so, don't report "0 cost".
  const zero = summarizeTraffic(
    [{ operation: "M:Holding:Transfer", confirmationRequest: 0, confirmationResponse: 0, total: 0 }],
    results,
    1000,
  )!;
  assert.equal(zero.unmetered, true);
  assert.equal(summarizeTraffic([], results, 1000), undefined);
});

test("the SLA gate can fail on a hotspot even when overall contention passes", () => {
  const results = [
    ...Array.from({ length: 9 }, () => op("contention", 50, { contractId: "registry" })),
    op("contention", 50, { contractId: "other" }),
    ...Array.from({ length: 90 }, () => op("committed", 10, { contractId: "fine" })),
  ];
  const i = instrument({ results, wallMs: 1000 });
  const summary = {
    ops: 100, committed: 90, contention: 10, rejected: 0, wallMs: 1000,
    throughputPerSec: 90, attemptedPerSec: 100, contentionRate: 0.1,
    latency: { p50: 10, p90: 50, p95: 50, p99: 50, max: 50, mean: 14 },
    latencyCurve: [],
  };
  // 10% contention is comfortably within a 25% budget…
  assert.equal(checkSla(summary, { maxContentionPct: 25 }, i).pass, true);
  // …but 90% of it sits on ONE contract, which is the real finding.
  const gate = checkSla(summary, { maxContentionPct: 25, maxHotspotSharePct: 50 }, i);
  assert.equal(gate.pass, false);
  assert.match(gate.failures[0], /one contract carries 90% of all contention/);
});

test("a transport failure is recorded as data, not thrown away", async () => {
  // Regression: the stress mode drove a real sandbox until sockets gave out,
  // and the raw `fetch failed` aborted the run, discarding every sample —
  // losing the very observation the test existed to make.
  const { LedgerClient, transportCause } = await import("../src/ledger.ts");
  // Nothing is listening on this port.
  const client = new LedgerClient("http://127.0.0.1:1");
  const res = await client.submitAndWait({
    commands: [{ CreateCommand: { templateId: "m:M:T", createArguments: {} } }],
    commandId: "x",
    actAs: ["p"],
  });
  assert.equal(res.ok, false);
  assert.match((res as { error: string }).error, /TRANSPORT_FAILURE/);
  // It classifies as an ordinary rejection, never as contention.
  assert.equal(classifyOutcome(res), "rejected");
  // And the cause is named, not a bare stack.
  assert.match(transportCause({ message: "fetch failed", cause: { code: "ECONNREFUSED" } }), /ECONNREFUSED/);
});

test("the SLA gate can fail on read-side lag", () => {
  const i = instrument({
    results: [op("committed", 5)],
    wallMs: 1000,
    lagSamples: [{ atMs: 0, offsetLag: 250, queryMs: 4 }],
  });
  assert.equal(checkSla(baseSummary(), { maxReadLagOffsets: 500 }, i).pass, true);
  const gate = checkSla(baseSummary(), { maxReadLagOffsets: 100 }, i);
  assert.equal(gate.pass, false);
  assert.match(gate.failures[0], /read-side lag 250 offsets above max 100/);
});

function baseSummary() {
  return {
    ops: 1, committed: 1, contention: 0, rejected: 0, wallMs: 1000,
    throughputPerSec: 1, attemptedPerSec: 1, contentionRate: 0,
    latency: { p50: 5, p90: 5, p95: 5, p99: 5, max: 5, mean: 5 },
    latencyCurve: [],
  };
}

test("formatInstrumentation names the bottleneck and stays quiet when there is none", () => {
  const hot = instrument({
    // Enough losses to justify the call: with only a handful, any single
    // contract holds a large share by arithmetic, so the formatter withholds
    // the bottleneck verdict (asserted below).
    results: [
      ...Array.from({ length: 12 }, () => op("contention", 80, { contractId: "registry0000000000" })),
      ...Array.from({ length: 20 }, () => op("committed", 10, { contractId: "other" })),
    ],
    wallMs: 1000,
  });
  const text = formatInstrumentation(hot);
  assert.match(text, /hot contracts/);
  assert.match(text, /registry0000/);
  assert.match(text, /single bottleneck/);

  // The same shape with too few losses reports the number but declines the call.
  const thin = formatInstrumentation(
    instrument({
      results: [
        ...Array.from({ length: 3 }, () => op("contention", 80, { contractId: "registry0000000000" })),
        ...Array.from({ length: 20 }, () => op("committed", 10, { contractId: "other" })),
      ],
      wallMs: 1000,
    }),
  );
  assert.match(thin, /too few losses to call a bottleneck/);
  assert.doesNotMatch(thin, /← single bottleneck/);

  // A clean run with one op kind and one party has nothing to report.
  const quiet = formatInstrumentation(instrument({ results: [op("committed", 5)], wallMs: 100 }));
  assert.equal(quiet, "");
});
