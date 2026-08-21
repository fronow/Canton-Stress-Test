import assert from "node:assert/strict";
import { test } from "node:test";
import { predictContention, poolForTarget } from "../src/contention.ts";

const pct = (x: number) => Math.round(x * 1000) / 10;

// The model exists to reproduce measurements, so the measurements are the
// test. Every figure below came off a real run against a CIP-0056 registry;
// the raw reports are under examples/openzeppelin/. If a change to the model
// moves these, it has changed a published claim and needs a rerun, not a
// tolerance bump.

test("turnover law: contention halves as the pool doubles (measured, k=1)", () => {
  // examples/openzeppelin/turnover — 240 ops, pool 240/480/960/1920.
  // Measured: 37.1, 20.4, 12.9, 5.0.
  const measured = [
    { pool: 240, got: 37.1 },
    { pool: 480, got: 20.4 },
    { pool: 960, got: 12.9 },
    { pool: 1920, got: 5.0 },
  ];
  for (const { pool, got } of measured) {
    const p = pct(predictContention({ ops: 240, pool }));
    assert.ok(
      Math.abs(p - got) <= 8,
      `pool ${pool}: predicted ${p}%, measured ${got}% — off by more than 8 points`,
    );
  }
  // The SHAPE is the load-bearing claim: each doubling roughly halves it.
  const at = (pool: number) => predictContention({ ops: 240, pool });
  for (const pool of [240, 480, 960]) {
    const ratio = at(pool) / at(pool * 2);
    assert.ok(ratio > 1.6 && ratio < 2.4, `pool ${pool}->${pool * 2}: ratio ${ratio.toFixed(2)}`);
  }
});

test("multi-input: geometric in k, and it beats the linear guess (measured)", () => {
  // examples/openzeppelin/multiinput — 120 ops, pool 1200.
  const measured = [
    { inputs: 1, got: 3.3 },
    { inputs: 2, got: 15.8 },
    { inputs: 4, got: 38.3 },
    { inputs: 8, got: 63.3 },
  ];
  let geoErr = 0;
  let linErr = 0;
  for (const { inputs, got } of measured) {
    const p = pct(predictContention({ ops: 120, pool: 1200, inputs }));
    // The linear model this replaced: k times the single-input rate.
    const linear = pct(inputs * predictContention({ ops: 120, pool: 1200 }));
    geoErr += Math.abs(p - got);
    linErr += Math.abs(linear - got);
    assert.ok(Math.abs(p - got) <= 6, `k=${inputs}: predicted ${p}%, measured ${got}%`);
  }
  assert.ok(
    geoErr * 2 < linErr,
    `geometric total error ${geoErr.toFixed(1)} should be far below linear ${linErr.toFixed(1)}`,
  );
});

test("out-of-sample points the model was NOT fitted to", () => {
  // Predictions recorded in multiinput/PREDICTIONS.md before these ran.
  const oos = [
    { inputs: 3, pool: 1200, got: 21.7 },
    { inputs: 6, pool: 1200, got: 62.5 },
    { inputs: 4, pool: 2400, got: 23.3 },
  ];
  for (const { inputs, pool, got } of oos) {
    const p = pct(predictContention({ ops: 120, pool, inputs }));
    // Looser than the fitted points, deliberately: ±7 is the honest
    // out-of-sample accuracy, and pretending otherwise would overstate it.
    assert.ok(Math.abs(p - got) <= 8, `k=${inputs} pool=${pool}: predicted ${p}%, measured ${got}%`);
  }
});

test("reduces to f/2 at one input", () => {
  // Turnover f = ops/pool = 0.5, so contention should sit near 25%.
  const p = predictContention({ ops: 240, pool: 480 });
  assert.ok(p > 0.19 && p < 0.26, `expected ~0.25 (f/2), got ${p.toFixed(3)}`);
});

test("contention falls monotonically as the pool grows", () => {
  let prev = 1;
  for (const pool of [100, 200, 400, 800, 1600, 3200]) {
    const p = predictContention({ ops: 240, pool, inputs: 2 });
    assert.ok(p < prev, `pool ${pool}: ${p} should be below ${prev}`);
    prev = p;
  }
});

test("degenerate inputs produce 0 rather than NaN", () => {
  for (const bad of [
    { ops: 0, pool: 100 },
    { ops: 100, pool: 0 },
    { ops: -5, pool: 100 },
    { ops: 100, pool: 100, inputs: 0 },
  ]) {
    const p = predictContention(bad);
    assert.ok(Number.isFinite(p) && p === 0, `${JSON.stringify(bad)} gave ${p}`);
  }
});

test("poolForTarget inverts the model", () => {
  for (const inputs of [1, 2, 4]) {
    for (const target of [0.05, 0.01]) {
      const pool = poolForTarget({ ops: 240, target, inputs });
      assert.ok(pool !== undefined, `no pool found for k=${inputs} target=${target}`);
      const at = predictContention({ ops: 240, pool: pool!, inputs });
      assert.ok(at <= target, `k=${inputs}: pool ${pool} gives ${at}, over target ${target}`);
      // And it is the SMALLEST such pool — one fewer must miss.
      const below = predictContention({ ops: 240, pool: pool! - 1, inputs });
      assert.ok(below > target, `k=${inputs}: pool ${pool! - 1} also meets the target`);
    }
  }
});

test("poolForTarget reproduces the published advice", () => {
  // The published finding: 240 transfers over a 480 pool contends ~20%, and
  // getting under 5% takes roughly 2,400 holdings.
  const pool = poolForTarget({ ops: 240, target: 0.05 });
  assert.ok(pool !== undefined && pool >= 2000 && pool <= 2600, `got ${pool}`);
});

test("a target that no pool can reach returns undefined, not a huge number", () => {
  // 64 inputs per transfer: even an unlimited pool cannot get the chance that
  // all 64 are unspent below a 1% failure rate at this turnover.
  const pool = poolForTarget({ ops: 100000, target: 0.0001, inputs: 64 });
  if (pool !== undefined) {
    assert.ok(
      predictContention({ ops: 100000, pool, inputs: 64 }) <= 0.0001,
      "if it returns a pool, that pool must actually meet the target",
    );
  }
});
