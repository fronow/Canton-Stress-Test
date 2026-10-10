// A failed cost estimate must be REPORTED, never silently dropped.
//
// The prepare call used to be wrapped in a catch that returned nothing, so a
// refused call left the report with no traffic section at all — which reads
// exactly like "nothing to report". That is how a missing-disclosure bug hid
// once already, and on a metered synchronizer it would let a run look like it
// measured cost when it had not.

import assert from "node:assert/strict";
import { test } from "node:test";
import { formatInstrumentation, instrument, summarizeTraffic } from "../src/instrument.ts";
import type { LedgerApi } from "../src/ledger.ts";
import { runMeasured } from "../src/load.ts";
import type { OpResult } from "../src/metrics.ts";
import type { Workload } from "../src/workload.ts";

const committed = (template: string, choice: string): OpResult => ({
  outcome: "committed",
  latencyMs: 5,
  attribution: { template, choice, parties: ["p"] },
});

test("failed estimates are listed with their reason and never counted as cost", () => {
  const t = summarizeTraffic(
    [
      { operation: "M:T:Go", confirmationRequest: 300, confirmationResponse: 200, total: 500 },
      { operation: "M:T:Stop", confirmationRequest: 0, confirmationResponse: 0, total: 0, error: "CONTRACT_NOT_FOUND" },
    ],
    [committed("pkg:M:T", "Go"), committed("pkg:M:T", "Stop")],
    1000,
  )!;
  assert.deepEqual(t.failed, [{ operation: "M:T:Stop", error: "CONTRACT_NOT_FOUND" }]);
  assert.equal(t.totalForRun, 500);
  assert.equal(t.perOperation.length, 1);
  // A failure is not evidence that the synchronizer is unmetered.
  assert.equal(t.unmetered, false);
});

test("when every estimate failed the report says FAILED, not UNMETERED", () => {
  const text = formatInstrumentation(
    instrument({
      results: [committed("pkg:M:T", "Go")],
      wallMs: 1000,
      trafficEstimates: [
        { operation: "M:T:Go", confirmationRequest: 0, confirmationResponse: 0, total: 0, error: "HTTP 400" },
      ],
    }),
  );
  assert.match(text, /traffic estimate FAILED for M:T:Go: HTTP 400/);
  assert.doesNotMatch(text, /UNMETERED/);
});

const workload: Workload = {
  parties: 1,
  setup: [],
  operations: [{ weight: 1, op: { kind: "create", template: "pkg:M:T", args: {} } }],
};

const fakeLedger = (over: Partial<LedgerApi>): LedgerApi => ({
  async allocateParty(hint) {
    return `${hint}::fake`;
  },
  async activeContracts() {
    return [];
  },
  async submitAndWait() {
    return { ok: true, updateId: "u" };
  },
  async submitAndWaitForTree() {
    return { ok: true, updateId: "u", created: [], exerciseResult: null };
  },
  ...over,
});

const run = (api: LedgerApi) =>
  runMeasured(
    api,
    workload,
    { kind: "closed", ops: 2, warmup: 0, concurrency: 1 },
    { parties: ["p0"], roles: {}, bindings: {} },
    { amount: "1.0", seed: 1, runId: "t" },
  );

test("a refused prepare call reaches the report with its reason (end to end)", async () => {
  const { report } = await run(
    fakeLedger({
      async connectedSynchronizerId() {
        return "sync::1";
      },
      async estimateTrafficCost() {
        throw new Error("CONTRACT_NOT_FOUND: factory not visible to submitter");
      },
    }),
  );
  assert.equal(report.summary.committed, 2, "the run itself must not fail over cost");
  const failed = report.instrumentation?.traffic?.failed ?? [];
  assert.equal(failed.length, 1);
  assert.match(failed[0].error, /CONTRACT_NOT_FOUND/);
});

test("an unknown synchronizer is reported instead of skipping cost silently", async () => {
  const { report } = await run(
    fakeLedger({
      async connectedSynchronizerId() {
        throw new Error("connection refused");
      },
      async estimateTrafficCost() {
        throw new Error("must not be called without a synchronizer");
      },
    }),
  );
  const failed = report.instrumentation?.traffic?.failed ?? [];
  assert.equal(failed.length, 1);
  assert.match(failed[0].error, /connected synchronizer/);
});

test("cost is estimated on the participant that HOSTS the submitter", async () => {
  // Found on a live two-participant network: every estimate went to the first
  // participant, which refuses to prepare for a party it does not host, so
  // multi-participant runs never had a cost figure at all.
  const refusing = fakeLedger({
    async connectedSynchronizerId() {
      return "sync::1";
    },
    async estimateTrafficCost() {
      throw new Error("ParticipantAuthorizationError: does not host p1");
    },
  });
  const hosting = fakeLedger({
    async connectedSynchronizerId() {
      return "sync::1";
    },
    async estimateTrafficCost() {
      return { confirmationRequest: 3600, confirmationResponse: 350, total: 3950, preparedBytes: 2000 };
    },
  });
  const { report } = await runMeasured(
    [refusing, hosting],
    {
      parties: 2,
      setup: [],
      // Submitted by p1, who lives on the SECOND participant; p0 keeps the
      // first one active, so it is first in line for anything unrouted.
      operations: [{ weight: 1, submit: { actAs: ["p1"] }, op: { kind: "create", template: "pkg:M:T", args: {} } }],
    },
    { kind: "closed", ops: 2, warmup: 0, concurrency: 1 },
    { parties: ["p0", "p1"], roles: {}, bindings: {}, hostOf: { p0: 0, p1: 1 } },
    { amount: "1.0", seed: 1, runId: "t" },
  );
  const t = report.instrumentation?.traffic;
  assert.deepEqual(t?.failed ?? [], []);
  assert.equal(t?.perOperation[0]?.total, 3950);
});
