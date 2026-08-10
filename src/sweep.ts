// Sweep runner (roadmap S7): run the same workload across a series of load
// levels — arrival rate (open model) or concurrency (closed model) — to find
// the throughput cliff and the latency knee. Each level runs with fresh party
// hints so runs are isolated (Canton privacy = run isolation).

import { runWorkload, type LoadModel, type LoadReport, type Network, type RunOptions } from "./load.ts";
import type { Workload } from "./workload.ts";

export interface SweepPoint {
  /** The swept value: ops/sec (open) or concurrency (closed). */
  level: number;
  report: LoadReport;
}

export interface SweepReport {
  dimension: "rate" | "concurrency";
  points: SweepPoint[];
}

export async function runSweep(
  network: Network,
  workload: Workload,
  baseModel: LoadModel,
  levels: number[],
  o: RunOptions,
): Promise<SweepReport> {
  const dimension = baseModel.kind === "open" ? "rate" : "concurrency";
  const points: SweepPoint[] = [];
  for (const level of levels) {
    const model: LoadModel =
      baseModel.kind === "open"
        ? { kind: "open", ops: baseModel.ops, warmup: baseModel.warmup, rate: level, maxInFlight: baseModel.maxInFlight }
        : { kind: "closed", ops: baseModel.ops, warmup: baseModel.warmup, concurrency: level };
    o.onProgress?.(0, 0); // let the CLI print a per-level header if it wants
    const report = await runWorkload(network, workload, model, { ...o, runId: `${o.runId}-L${level}` });
    points.push({ level, report });
  }
  return { dimension, points };
}
