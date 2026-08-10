// Prometheus text-format export (roadmap M3).
//
// A load test that only prints to a terminal is read once and forgotten. The
// same numbers in the dashboard a team already watches get looked at every
// week, and a capacity regression becomes visible next to the graphs people
// use for everything else.
//
// Emits the Prometheus text exposition format, which is deliberately boring:
// it can be scraped by a Pushgateway, appended to a node-exporter textfile
// directory, or piped straight into `promtool`. No dependency, no daemon.

import type { Instrumentation } from "./instrument.ts";
import type { LoadReport } from "./load.ts";
import type { Summary } from "./metrics.ts";

/** Label values must not contain a backslash, newline or double quote. */
const esc = (s: string): string =>
  s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');

const labelsOf = (labels: Record<string, string>): string => {
  const pairs = Object.entries(labels)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}="${esc(v)}"`);
  return pairs.length > 0 ? `{${pairs.join(",")}}` : "";
};

interface Metric {
  name: string;
  help: string;
  type: "gauge" | "counter";
  samples: Array<{ labels: Record<string, string>; value: number }>;
}

const P = "canton_stress";

function summaryMetrics(s: Summary, base: Record<string, string>): Metric[] {
  return [
    {
      name: `${P}_throughput_per_second`,
      help: "Committed transactions per second over the measured window.",
      type: "gauge",
      samples: [{ labels: base, value: s.throughputPerSec }],
    },
    {
      name: `${P}_attempted_per_second`,
      help: "All submissions per second, committed or not.",
      type: "gauge",
      samples: [{ labels: base, value: s.attemptedPerSec }],
    },
    {
      name: `${P}_latency_seconds`,
      help: "Submit-to-outcome latency percentiles, in seconds.",
      type: "gauge",
      // Reported as a summary-style quantile series: Grafana and alerting
      // rules both understand `quantile`, and seconds is the Prometheus base
      // unit (milliseconds would be idiomatically wrong).
      samples: [
        { labels: { ...base, quantile: "0.5" }, value: s.latency.p50 / 1000 },
        { labels: { ...base, quantile: "0.9" }, value: s.latency.p90 / 1000 },
        { labels: { ...base, quantile: "0.95" }, value: s.latency.p95 / 1000 },
        { labels: { ...base, quantile: "0.99" }, value: s.latency.p99 / 1000 },
        { labels: { ...base, quantile: "1" }, value: s.latency.max / 1000 },
      ],
    },
    {
      name: `${P}_operations_total`,
      help: "Operations by outcome.",
      type: "counter",
      samples: [
        { labels: { ...base, outcome: "committed" }, value: s.committed },
        { labels: { ...base, outcome: "contention" }, value: s.contention },
        { labels: { ...base, outcome: "rejected" }, value: s.rejected },
      ],
    },
    {
      name: `${P}_contention_ratio`,
      help: "Share of operations that lost a race, 0..1.",
      type: "gauge",
      samples: [{ labels: base, value: s.contentionRate }],
    },
    {
      name: `${P}_run_duration_seconds`,
      help: "Wall-clock length of the measured window.",
      type: "gauge",
      samples: [{ labels: base, value: s.wallMs / 1000 }],
    },
  ];
}

function instrumentationMetrics(i: Instrumentation, base: Record<string, string>): Metric[] {
  const out: Metric[] = [];

  if (i.contentionConcentration !== undefined)
    out.push({
      name: `${P}_contention_concentration`,
      help: "Share of all contention carried by the single worst contract, 0..1. Near 1 means one bottleneck.",
      type: "gauge",
      samples: [{ labels: base, value: i.contentionConcentration }],
    });

  // Per-operation rather than per-contract: contract ids are unbounded and
  // high-cardinality labels are how monitoring systems get destroyed.
  if (i.byOperation.length > 0)
    out.push({
      name: `${P}_operation_contention_ratio`,
      help: "Contention rate per operation kind, 0..1.",
      type: "gauge",
      samples: i.byOperation.map((o) => ({
        labels: { ...base, operation: o.key },
        value: o.contentionRate,
      })),
    });

  if (i.readLag)
    out.push({
      name: `${P}_read_lag_offsets`,
      help: "Maximum observed lag of the read path behind the write path, in ledger offsets.",
      type: "gauge",
      samples: [{ labels: base, value: i.readLag.maxOffsetLag }],
    });

  if (i.traffic && !i.traffic.unmetered)
    out.push({
      name: `${P}_traffic_cost_total`,
      help: "CIP-0104 traffic units consumed by the measured window.",
      type: "counter",
      samples: [{ labels: base, value: i.traffic.totalForRun }],
    });

  return out;
}

/** Render a finished run in the Prometheus text exposition format. */
export function renderPrometheus(
  report: LoadReport,
  o: { job?: string; labels?: Record<string, string> } = {},
): string {
  const base: Record<string, string> = {
    job: o.job ?? "canton_stress",
    model: report.model,
    ...o.labels,
  };

  const metrics = [
    ...summaryMetrics(report.summary, base),
    ...(report.instrumentation ? instrumentationMetrics(report.instrumentation, base) : []),
  ];

  const lines: string[] = [];
  for (const m of metrics) {
    lines.push(`# HELP ${m.name} ${m.help}`);
    lines.push(`# TYPE ${m.name} ${m.type}`);
    for (const s of m.samples)
      // Prometheus rejects non-finite values; emit nothing rather than "NaN".
      if (Number.isFinite(s.value)) lines.push(`${m.name}${labelsOf(s.labels)} ${s.value}`);
  }
  return lines.join("\n") + "\n";
}
