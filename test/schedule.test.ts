import assert from "node:assert/strict";
import { test } from "node:test";
import { runClosed, runOpen, type Clock, type Task } from "../src/schedule.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A virtual clock: time only moves when sleep() is called or a task advances
// it. Because the overloaded open-model scenario below never sleeps in the
// scheduler (arrivals are already overdue), ordering is deterministic.
function virtualClock() {
  let vt = 0;
  const clock: Clock = {
    now: () => vt,
    sleep: async (ms: number) => {
      if (ms > 0) vt += ms;
    },
  };
  return { clock, advance: (ms: number) => { vt += ms; } };
}

test("OPEN model is coordinated-omission correct: a backlog inflates scheduled latency", async () => {
  const vc = virtualClock();
  // Every op takes a FLAT 5ms of service, but arrivals are scheduled every 1ms
  // (1000/s) — the system cannot keep up. maxInFlight:1 serializes execution so
  // the result is exact.
  const task: Task = async () => {
    vc.advance(5);
    return { ok: true };
  };
  const { results } = await runOpen({
    count: 5,
    warmup: 0,
    ratePerSec: 1000,
    maxInFlight: 1,
    task,
    clock: vc.clock,
  });
  const lat = results.map((r) => Math.round(r.latencyMs));
  // A naive tester measuring service time would report a flat [5,5,5,5,5] and
  // conclude "5ms, all good." Measured from each op's intended 1ms arrival
  // slot, the growing queue is visible — this is the whole point of S3.
  assert.deepEqual(lat, [5, 9, 13, 17, 21]);
});

test("OPEN model: warmup ops are executed but excluded; achievedRate is reported", async () => {
  const task: Task = async () => {
    await sleep(1);
    return { ok: true };
  };
  const { results, achievedRatePerSec, wallMs } = await runOpen({
    count: 20,
    warmup: 5,
    ratePerSec: 200,
    maxInFlight: 10,
    task,
  });
  assert.equal(results.length, 15); // 20 run, first 5 warmup discarded
  assert.ok(results.every((r) => r.outcome === "committed"));
  assert.ok(achievedRatePerSec > 0 && wallMs > 0);
});

test("OPEN model: contention errors are classified through the scheduler", async () => {
  const task: Task = async () => ({ ok: false, error: "LOCAL_VERDICT_LOCKED: locked" });
  const { results } = await runOpen({
    count: 4,
    warmup: 0,
    ratePerSec: 1000,
    maxInFlight: 2,
    task,
  });
  assert.ok(results.every((r) => r.outcome === "contention"));
});

test("CLOSED model: respects concurrency cap and excludes warmup", async () => {
  let inFlight = 0;
  let peak = 0;
  const task: Task = async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await sleep(2);
    inFlight--;
    return { ok: true };
  };
  const results = await runClosed({ count: 20, warmup: 4, concurrency: 5, task });
  assert.equal(results.length, 16); // warmup excluded
  assert.ok(peak <= 5, `peak ${peak} exceeded concurrency 5`);
  assert.ok(peak >= 2, `expected real concurrency, saw ${peak}`);
  assert.ok(results.every((r) => r.outcome === "committed"));
});
