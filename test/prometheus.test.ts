import assert from "node:assert/strict";
import { test } from "node:test";
import { instrument } from "../src/instrument.ts";
import type { LoadReport } from "../src/load.ts";
import { summarize, type OpResult } from "../src/metrics.ts";
import { renderPrometheus } from "../src/prometheus.ts";

function report(): LoadReport {
  const results: OpResult[] = [];
  for (let i = 0; i < 100; i++)
    results.push({
      outcome: i < 80 ? "committed" : i < 92 ? "contention" : "rejected",
      latencyMs: 100 + i * 10,
      attribution: {
        template: "pkg:M:Holding",
        choice: "Transfer",
        contractId: `c${i % 7}`,
        parties: ["alice"],
      },
    });
  return {
    model: "open",
    parties: 5,
    ops: 100,
    summary: summarize(results, 10_000),
    instrumentation: instrument({ results, wallMs: 10_000, lagSamples: [{ atMs: 0, offsetLag: 12, queryMs: 4 }] }),
  };
}

const lines = (text: string) => text.split("\n").filter((l) => l && !l.startsWith("#"));
const valueOf = (text: string, prefix: string) =>
  Number(lines(text).find((l) => l.startsWith(prefix))?.split(" ").pop());

test("emits valid Prometheus text format: every series has HELP and TYPE", () => {
  const text = renderPrometheus(report());
  const names = new Set(lines(text).map((l) => l.split("{")[0].split(" ")[0]));
  for (const n of names) {
    assert.ok(text.includes(`# HELP ${n} `), `${n} is missing HELP`);
    assert.ok(text.includes(`# TYPE ${n} `), `${n} is missing TYPE`);
  }
  assert.ok(text.endsWith("\n"), "the exposition format requires a trailing newline");
  // Every sample line must be `name{labels} <number>`.
  for (const l of lines(text)) assert.match(l, /^[a-z_]+(\{[^}]*\})? -?[\d.e+-]+$/i, l);
});

test("latency is exported in SECONDS as quantiles, not milliseconds", () => {
  // Prometheus' base unit is seconds; exporting milliseconds would silently
  // make every dashboard and alert threshold wrong by 1000x.
  const text = renderPrometheus(report());
  const p99Ms = report().summary.latency.p99;
  const p99 = Number(
    lines(text).find((l) => l.startsWith("canton_stress_latency_seconds") && l.includes('quantile="0.99"'))?.split(" ").pop(),
  );
  assert.ok(Math.abs(p99 - p99Ms / 1000) < 1e-9, `${p99} should be ${p99Ms}ms in seconds`);
  assert.ok(p99 < 100, "a p99 in seconds must not look like a millisecond figure");
});

test("outcomes are exported as a labelled counter that sums to the op count", () => {
  const text = renderPrometheus(report());
  const total = ["committed", "contention", "rejected"]
    .map((o) => valueOf(text, `canton_stress_operations_total{job="canton_stress",model="open",outcome="${o}"}`))
    .reduce((a, b) => a + b, 0);
  assert.equal(total, 100);
});

test("custom labels are applied to every series, and escaped", () => {
  const text = renderPrometheus(report(), { labels: { app: 'my"app', env: "ci" } });
  for (const l of lines(text)) {
    assert.match(l, /env="ci"/);
    assert.match(l, /app="my\\"app"/, "a quote in a label value must be escaped");
  }
});

test("contract ids are NOT used as labels", () => {
  // Unbounded label cardinality is how a monitoring system gets taken down.
  // Contention is exported per OPERATION kind, which is bounded by the
  // workload, never per contract.
  const text = renderPrometheus(report());
  assert.ok(text.includes("canton_stress_operation_contention_ratio"));
  assert.doesNotMatch(text, /contract(_?id)?="/i);
});

test("instrumentation is exported when present, and skipped when absent", () => {
  const withInstr = renderPrometheus(report());
  assert.match(withInstr, /canton_stress_read_lag_offsets\S* 12/);
  assert.match(withInstr, /canton_stress_contention_concentration/);

  const bare = report();
  bare.instrumentation = undefined;
  const text = renderPrometheus(bare);
  assert.doesNotMatch(text, /read_lag|concentration/);
  // The core summary must still be there.
  assert.match(text, /canton_stress_throughput_per_second/);
});

test("unmetered traffic is omitted rather than exported as a zero cost", () => {
  const r = report();
  r.instrumentation = instrument({
    results: [{ outcome: "committed", latencyMs: 5 }],
    wallMs: 1000,
    trafficEstimates: [{ operation: "M:T:C", confirmationRequest: 0, confirmationResponse: 0, total: 0 }],
  });
  // A sandbox reports zero because there is no traffic control, not because
  // the run was free. Exporting 0 would put a false line on a cost dashboard.
  assert.doesNotMatch(renderPrometheus(r), /traffic_cost/);
});

test("non-finite values are dropped, not emitted as NaN", () => {
  const r = report();
  r.summary = { ...r.summary, wallMs: 0, throughputPerSec: Infinity, attemptedPerSec: NaN };
  const text = renderPrometheus(r);
  assert.doesNotMatch(text, /NaN|Infinity/);
});
