import assert from "node:assert/strict";
import { test } from "node:test";
import type { LoadModel } from "../src/load.ts";
import type { ModeSpec } from "../src/modes.ts";
import {
  checkSafety,
  countSetupCommands,
  DEFAULT_LIMITS,
  describePlan,
  estimateTotalCommands,
  isLocalEndpoint,
  peakRate,
  type RunPlan,
} from "../src/safety.ts";
import {
  applyParams,
  ParamError,
  requiredParams,
  validateWorkload,
  WORKLOAD_FORMAT_VERSION,
  type Workload,
} from "../src/workload.ts";

const workload: Workload = {
  parties: 3,
  setup: [],
  operations: [{ weight: 1, op: { kind: "create", template: "p:M:T", args: {} } }],
};

const plan = (o: Partial<RunPlan> = {}): RunPlan => ({
  endpoints: ["http://localhost:7575"],
  workers: 1,
  model: { kind: "closed", ops: 100, warmup: 0, concurrency: 16 },
  workload,
  workloadLabel: "create",
  setupCommands: 0,
  sandbox: false,
  ...o,
});

test("local endpoints are recognised; anything else counts as remote", () => {
  for (const url of [
    "http://localhost:7575",
    "http://127.0.0.1:7575",
    "https://127.9.9.9:443",
    "http://[::1]:7575",
    "http://0.0.0.0:7575",
  ])
    assert.equal(isLocalEndpoint(url), true, url);

  for (const url of [
    "http://ledger.example.com:7575",
    "http://10.0.0.5:7575", // a private LAN address is still someone else's box
    "http://192.168.1.20:7575",
    "not a url",
  ])
    assert.equal(isLocalEndpoint(url), false, url);
});

test("a remote participant is REFUSED unless explicitly allowed", () => {
  const remote = plan({ endpoints: ["http://prod.example.com:7575"] });
  const refused = checkSafety(remote, DEFAULT_LIMITS);
  assert.equal(refused.length, 1);
  assert.match(refused[0], /refusing to generate load against a non-local participant/);
  assert.match(refused[0], /--allow-remote/);

  // Opting in clears it.
  assert.deepEqual(checkSafety(remote, { ...DEFAULT_LIMITS, allowRemote: true }), []);
  // A mixed list is caught on the remote member alone.
  const mixed = plan({ endpoints: ["http://localhost:7575", "http://prod.example.com:7575"] });
  assert.match(checkSafety(mixed, DEFAULT_LIMITS)[0], /prod\.example\.com/);
  // A sandbox we booted ourselves is exempt.
  assert.deepEqual(checkSafety(plan({ sandbox: true }), DEFAULT_LIMITS), []);
});

test("a mistyped rate is stopped, and the message names the flag that lifts it", () => {
  const fast = plan({ model: { kind: "open", ops: 100, warmup: 0, rate: 5000 } });
  const [problem] = checkSafety(fast, DEFAULT_LIMITS);
  assert.match(problem, /offered rate 5000\/s exceeds the safety cap of 1000\/s/);
  assert.match(problem, /--max-rate 5000/);
  assert.deepEqual(checkSafety(fast, { ...DEFAULT_LIMITS, maxRate: 5000 }), []);
});

test("the cap is checked against a ramp's PEAK, not its starting rate", () => {
  // Starts at a harmless 10/s but ends at 9000/s — checking `rate` alone would
  // wave this through.
  const modeSpec: ModeSpec = {
    mode: "ramp", durationMs: 60_000, fromRate: 10, toRate: 9000, bucketMs: 2000, warmupMs: 2000,
  };
  const ramp = plan({ model: { kind: "open", ops: 0, warmup: 0, rate: 10, modeSpec }, modeSpec });
  assert.equal(peakRate(ramp.model, modeSpec), 9000);
  assert.match(checkSafety(ramp, DEFAULT_LIMITS)[0], /9000\/s exceeds/);
});

test("volume and duration caps hold", () => {
  const many = plan({ model: { kind: "closed", ops: 5_000_000, warmup: 0, concurrency: 8 } });
  assert.match(checkSafety(many, DEFAULT_LIMITS)[0], /5000000 operations exceeds/);

  const long = plan({ model: { kind: "closed", ops: 100, warmup: 0, concurrency: 8, durationMs: 36_000_000 } });
  const [d] = checkSafety(long, DEFAULT_LIMITS);
  assert.match(d, /36000s run exceeds the safety cap of 3600s/);
  assert.match(d, /--max-duration 36000/);
});

test("a safe plan passes every check", () => {
  assert.deepEqual(checkSafety(plan(), DEFAULT_LIMITS), []);
});

test("countSetupCommands counts repetitions, not steps", () => {
  const w: Workload = {
    parties: 2,
    setup: [
      { id: "f", op: { kind: "create", template: "M:F", args: {} } },
      { id: "a", count: 6, op: { kind: "create", template: "M:A", args: {} } },
      { kind: "create", template: "M:B", args: {} }, // the bare pre-S2 form
    ],
    operations: workload.operations,
  };
  assert.equal(countSetupCommands(w), 8);
});

test("the plan estimates the blast radius, including duration-driven runs", () => {
  // Counted run: setup + ops.
  assert.equal(estimateTotalCommands(plan({ setupCommands: 32 })), 132);

  // Duration-driven ramp: integrate the AVERAGE rate over the window, not the
  // peak — 5→60/s over 90s averages 32.5/s.
  const modeSpec: ModeSpec = {
    mode: "ramp", durationMs: 90_000, fromRate: 5, toRate: 60, bucketMs: 3000, warmupMs: 9000,
  };
  const ramp = plan({
    setupCommands: 32,
    model: { kind: "open", ops: 0, warmup: 0, rate: 5, modeSpec },
    modeSpec,
  });
  assert.equal(estimateTotalCommands(ramp), 32 + Math.round(32.5 * 90));
});

test("describePlan states the target, the load and the total, without running anything", () => {
  const modeSpec: ModeSpec = {
    mode: "ramp", durationMs: 90_000, fromRate: 5, toRate: 60, bucketMs: 3000, warmupMs: 9000,
  };
  const text = describePlan(
    plan({
      endpoints: ["http://localhost:7575"],
      workers: 3,
      setupCommands: 32,
      model: { kind: "open", ops: 0, warmup: 0, rate: 5, modeSpec },
      modeSpec,
      workloadLabel: "file:settlement.json",
    }),
  );
  assert.match(text, /target:\s+http:\/\/localhost:7575/);
  assert.match(text, /setup:\s+32 command/);
  assert.match(text, /arrivals:\s+5\/s → 60\/s \(peak 60\/s\)/);
  assert.match(text, /workers:\s+3 processes/);
  assert.match(text, /ESTIMATED TOTAL COMMANDS SUBMITTED: ~2957/);
});

test("applyParams substitutes values anywhere, including template ids and counts", () => {
  const template = {
    parties: "$param:parties",
    setup: [
      { id: "f", count: "$param:n", op: { kind: "create", template: "$param:tpl", args: "$param:args" } },
    ],
    label: "run-$param:name-1",
  };
  const out = applyParams(template, {
    parties: 6,
    n: 400,
    tpl: "#pkg:M:T",
    args: { owner: "$p0", amount: "10.0" },
    name: "alpha",
  }) as Record<string, any>;

  // A bare "$param:x" yields the VALUE, so numbers stay numbers and records
  // stay records — a stringified 6 would fail validation.
  assert.equal(out.parties, 6);
  assert.equal(out.setup[0].count, 400);
  assert.deepEqual(out.setup[0].op.args, { owner: "$p0", amount: "10.0" });
  assert.equal(out.setup[0].op.template, "#pkg:M:T");
  // Embedded in a longer string it substitutes textually.
  assert.equal(out.label, "run-alpha-1");
});

test("a missing parameter fails loudly, naming every one that is absent", () => {
  assert.throws(
    () => applyParams({ a: "$param:one", b: ["$param:two"] }, {}),
    (e: unknown) => e instanceof ParamError && /one, two/.test(e.message) && /--set-json/.test(e.message),
  );
});

test("requiredParams lists what a library template needs", () => {
  const needed = requiredParams({
    parties: "$param:parties",
    setup: [{ op: { template: "$param:tpl", args: { x: "$param:tpl" } } }],
    fixed: "no placeholders here",
  });
  assert.deepEqual(needed, ["parties", "tpl"], "de-duplicated and sorted");
  assert.deepEqual(requiredParams({ a: 1, b: "plain" }), []);
});

test("runtime placeholders survive parameter substitution", () => {
  // "$p0" / "$role:admin" belong to the RUN, not the template — they must pass
  // through untouched or a parameterised workload loses its bindings.
  const out = applyParams(
    { args: { owner: "$p0", admin: "$role:admin", cid: "$ref:factory", when: "$now+1h" }, t: "$param:tpl" },
    { tpl: "#p:M:T" },
  ) as Record<string, any>;
  assert.deepEqual(out.args, { owner: "$p0", admin: "$role:admin", cid: "$ref:factory", when: "$now+1h" });
});

test("workload format versions are validated, not silently misread", () => {
  const ok: Workload = { ...workload, version: WORKLOAD_FORMAT_VERSION };
  assert.deepEqual(validateWorkload(ok), []);
  // Absent means "current" — every pre-S8 file keeps working.
  assert.deepEqual(validateWorkload(workload), []);

  const future = validateWorkload({ ...workload, version: WORKLOAD_FORMAT_VERSION + 1 });
  assert.match(future[0], /declares format version 2, but this build understands up to 1/);
  assert.match(validateWorkload({ ...workload, version: 0 })[0], /version must be a positive integer/);
});
