import assert from "node:assert/strict";
import { test } from "node:test";
import { instrument } from "../src/instrument.ts";
import { analyseMode } from "../src/modes.ts";
import type { LoadReport } from "../src/load.ts";
import { summarize, type OpResult } from "../src/metrics.ts";
import { renderReport } from "../src/render.ts";

function sampleReport(): LoadReport {
  const results: OpResult[] = [];
  for (let i = 0; i < 100; i++)
    results.push({
      outcome: i < 80 ? "committed" : i < 92 ? "contention" : "rejected",
      latencyMs: 50 + i * 3, // spread so percentiles differ
    });
  return {
    model: "open",
    parties: 5,
    ops: 100,
    targetRatePerSec: 15,
    achievedRatePerSec: 4.2,
    summary: summarize(results, 5000),
  };
}

test("renderReport produces a self-contained HTML page (no external assets)", () => {
  const html = renderReport(sampleReport());
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<svg/); // inline chart
  // Self-contained: no external URLs, no script/link/img tags pulling resources.
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<link\b/i);
  assert.doesNotMatch(html, /<img\b/i);
});

test("renderReport surfaces the key numbers and the CO note", () => {
  const html = renderReport(sampleReport());
  assert.match(html, /canton-stress/);
  assert.match(html, /coordinated-omission/); // the methodology callout
  assert.match(html, /p99/); // percentile chart labels
  assert.match(html, /p50/);
  assert.match(html, /Contention/);
  assert.match(html, /target 15\/s/); // open-model arrival line
  assert.match(html, /achieved 4\.2\/s/);
});

test("renderReport says what state the run was measured against (S2 setup)", () => {
  const rep = sampleReport();
  rep.setup = { steps: 4, submitted: 32, bindings: { accounts: 6, holdings: 24 } };
  const html = renderReport(rep);
  assert.match(html, /32 cmds \/ 4 steps/);
  assert.match(html, /accounts×6, holdings×24/);
  // A run with no setup phase must not grow an empty chip.
  assert.doesNotMatch(renderReport(sampleReport()), /setup:/);
});

test("renderReport renders the S4 Canton instrumentation section", () => {
  const rep = sampleReport();
  rep.instrumentation = instrument({
    results: [
      ...Array.from({ length: 8 }, () => ({
        outcome: "contention" as const,
        latencyMs: 90,
        attribution: { template: "pkg:Settlement:Registry", contractId: "regcid0000", choice: "Record", parties: ["op::x"] },
      })),
      {
        outcome: "committed" as const,
        latencyMs: 10,
        attribution: { template: "pkg:Settlement:Holding", contractId: "h1", choice: "Transfer", parties: ["alice::x"] },
      },
    ],
    wallMs: 1000,
    lagSamples: [{ atMs: 0, offsetLag: 7, queryMs: 3 }],
    trafficEstimates: [
      { operation: "Settlement:Holding:Transfer", confirmationRequest: 0, confirmationResponse: 0, total: 0 },
    ],
  });
  const html = renderReport(rep);
  assert.match(html, /Canton instrumentation/);
  assert.match(html, /Hot contracts/);
  assert.match(html, /regcid0000/);
  assert.match(html, /single bottleneck/);
  assert.match(html, /Read-side lag/);
  // An unmetered synchronizer must say so, not report a cost of 0.
  assert.match(html, /unmetered/);
  assert.doesNotMatch(html, /https?:\/\//);
  // A run with no instrumentation must not grow an empty section.
  assert.doesNotMatch(renderReport(sampleReport()), /Canton instrumentation/);
});

test("renderReport renders the S5 mode section with a time-series chart", () => {
  const rep = sampleReport();
  const results = [];
  for (let b = 0; b < 8; b++)
    for (let i = 0; i < 20; i++)
      results.push({ outcome: "committed" as const, latencyMs: b < 4 ? 20 : 400, atMs: b * 1000 });
  rep.modeReport = analyseMode(
    { mode: "ramp", durationMs: 8000, fromRate: 5, toRate: 40, bucketMs: 1000, warmupMs: 0 },
    results,
  );
  const html = renderReport(rep);
  assert.match(html, /behaviour over time/);
  assert.match(html, /Latency knee/);
  assert.match(html, /<polyline/); // the time series itself
  assert.match(html, /offered\/s/); // legend
  assert.doesNotMatch(html, /https?:\/\//);
  // A plain run must not grow an empty mode section.
  assert.doesNotMatch(renderReport(sampleReport()), /behaviour over time/);
});

test("renderReport handles a closed-model report too", () => {
  const rep = sampleReport();
  rep.model = "closed";
  rep.targetRatePerSec = undefined;
  rep.achievedRatePerSec = undefined;
  const html = renderReport(rep);
  assert.match(html, /self-paced/);
  assert.doesNotMatch(html, /https?:\/\//);
});

