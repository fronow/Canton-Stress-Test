import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  appendHistory,
  checkTrend,
  loadHistory,
  summarizeTrend,
  toHistoryEntry,
  type HistoryEntry,
} from "../src/history.ts";
import type { LoadReport } from "../src/load.ts";
import { summarize, type OpResult } from "../src/metrics.ts";

const entry = (throughputPerSec: number, p99Ms: number, i = 0): HistoryEntry => ({
  at: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
  runId: `r${i}`,
  model: "closed",
  ops: 100,
  committed: 100,
  throughputPerSec,
  p50Ms: p99Ms / 2,
  p99Ms,
  contentionRate: 0,
});

const tmp = (): string => mkdtempSync(join(tmpdir(), "cs-hist-"));

test("history round-trips as JSON Lines and survives a corrupt line", () => {
  const dir = tmp();
  try {
    const f = join(dir, "h.jsonl");
    appendHistory(f, entry(10, 100, 0));
    appendHistory(f, entry(11, 110, 1));
    // A truncated write, the way a killed process leaves one.
    writeFileSync(f, readFileSync(f, "utf8") + '{"at":"broken\n');
    appendHistory(f, entry(12, 120, 2));

    const loaded = loadHistory(f);
    assert.equal(loaded.length, 3, "one unreadable line must not lose the other runs");
    assert.deepEqual(loaded.map((e) => e.throughputPerSec), [10, 11, 12]);
    assert.deepEqual(loadHistory(join(dir, "missing.jsonl")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ONE bad run does not poison the comparison — the reason this uses a median", () => {
  // The single-baseline design fails here: if the outlier happened to be the
  // baseline, every later run would look like a 60% regression until somebody
  // re-recorded it.
  const history = [
    entry(10, 100, 0),
    entry(10.2, 105, 1),
    entry(4, 400, 2), // one bad afternoon
    entry(9.8, 98, 3),
    entry(10.1, 102, 4),
  ];
  const t = summarizeTrend(history)!;
  // Median of the prior four (10, 10.2, 4, 9.8) is unmoved by the outlier.
  assert.ok(Math.abs(t.medianThroughput - 9.9) < 0.001);
  assert.ok(Math.abs(t.throughputChangePct) < 5, "a healthy run must not look like a regression");
  assert.equal(checkTrend(t, { maxThroughputDropPct: 10, maxP99RisePct: 25 }).pass, true);
});

test("a real regression is still caught", () => {
  const history = [
    ...Array.from({ length: 5 }, (_, i) => entry(10, 100, i)),
    entry(6, 260, 5), // the run under test: throughput down 40%, p99 up 160%
  ];
  const t = summarizeTrend(history)!;
  assert.equal(t.medianThroughput, 10);
  assert.equal(Math.round(t.throughputChangePct), -40);
  assert.equal(Math.round(t.p99ChangePct), 160);

  const gate = checkTrend(t, { maxThroughputDropPct: 10, maxP99RisePct: 25 });
  assert.equal(gate.pass, false);
  assert.equal(gate.failures.length, 2);
  assert.match(gate.failures[0], /throughput 40% below the median of the last 5 runs/);
  assert.match(gate.failures[1], /p99 160% above the median/);
});

test("drift over a long history is reported separately from the latest run", () => {
  // Every run is fine against its immediate neighbours, yet the system has
  // halved over the series — the thing a two-run comparison cannot see.
  const history = Array.from({ length: 12 }, (_, i) => entry(12 - i * 0.5, 100 + i * 20, i));
  const t = summarizeTrend(history)!;
  assert.ok(t.driftThroughputPct !== undefined);
  assert.ok(t.driftThroughputPct < -20, `expected clear downward drift, got ${t.driftThroughputPct}`);
  assert.ok((t.driftP99Pct ?? 0) > 20, "and p99 climbing across the same span");
});

test("too little history reports nothing rather than guessing", () => {
  assert.equal(summarizeTrend([]), undefined);
  assert.equal(summarizeTrend([entry(10, 100)]), undefined);
  // And a gate with no trend cannot fail a build.
  assert.equal(checkTrend(undefined, { maxThroughputDropPct: 1 }).pass, true);
  // Drift needs enough runs to have distinct thirds.
  assert.equal(summarizeTrend([entry(10, 100, 0), entry(10, 100, 1)])!.driftThroughputPct, undefined);
});

test("the window bounds how far back the comparison reaches", () => {
  // Ancient history must not drag the median: 20 slow runs, then 5 fast ones.
  const history = [
    ...Array.from({ length: 20 }, (_, i) => entry(2, 500, i)),
    ...Array.from({ length: 5 }, (_, i) => entry(10, 100, 20 + i)),
    entry(10, 100, 25),
  ];
  const windowed = summarizeTrend(history, 5)!;
  assert.equal(windowed.medianThroughput, 10, "only the recent runs count");
  assert.ok(Math.abs(windowed.throughputChangePct) < 1);
});

test("toHistoryEntry captures what a trend needs from a report", () => {
  const results: OpResult[] = Array.from({ length: 10 }, (_, i) => ({
    outcome: i < 8 ? "committed" : "contention",
    latencyMs: 100 + i * 10,
  }));
  const report: LoadReport = {
    model: "open",
    parties: 3,
    ops: 10,
    summary: summarize(results, 1000),
  };
  const e = toHistoryEntry(report, { runId: "abc", label: "deadbeef", at: new Date(0) });
  assert.equal(e.runId, "abc");
  assert.equal(e.label, "deadbeef");
  assert.equal(e.model, "open");
  assert.equal(e.committed, 8);
  assert.equal(e.at, "1970-01-01T00:00:00.000Z");
  assert.ok(e.p99Ms > 0 && e.throughputPerSec > 0);
});
