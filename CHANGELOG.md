# Changelog

All notable changes to canton-stress. Versions track the
institutional roadmap milestones (S1–S9); the tool
stays pre-1.0 until the multi-participant half of S6 is real.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [SemVer](https://semver.org/spec/v2.0.0.html).

---

## [1.0.0] — 2026-08-01 — S6 completed: real multi-participant topology

The S1–S9 roadmap is complete.

### Added

- **`examples/network/`** — a real Canton network: two participants, a
  sequencer and a mediator on one synchronizer, booted from the Canton
  distribution **already bundled with the Daml SDK**. Runbook in its README.
- **Party-to-participant placement** — `"placement": "round-robin"` spreads the
  party population across the participants passed to `--api`; `rolePlacement`
  pins named roles to a node. `--setup-only` prints the placement.
- **Participant-local context** — the party pool `$party` draws from and the
  contract snapshot targets come from are node-local, because a participant
  sees only its own parties' projections.
- **Submitter-based routing** — every operation is submitted to the participant
  hosting its submitter. Setup steps route the same way.
- `PaymentOffer`/`Payment` in the settlement example: the propose/accept shape
  a cross-participant workflow requires, since Canton will not accept a
  submission co-signed by parties on different nodes.

### Fixed

- Several `--api` endpoints no longer force the distributed-worker path. Only
  `--workers` selects it. Conflating "a network" with "several load generators"
  sent every submission to one node and rejected every cross-participant
  operation.
- Workers driving a placed workload now connect to every participant, not just
  the one they were assigned.

- **Remote workers** — `canton-stress worker` speaks line-delimited JSON on
  stdio (one job in, one result out, ready/go barrier preserved), and
  `--worker-cmd` runs each worker via an arbitrary command. Any transport that
  runs a command and pipes stdio now works: ssh, kubectl, docker. Verified with
  local stdio subprocesses; a real network hop is not verified here (no sshd or
  Docker on the development machine).

### Corrected

- Earlier versions of `README.md` recorded multi-participant
  support as **blocked** for want of a Canton distribution. That was wrong — the
  SDK bundles `canton.jar`, and the claim came from searching only the project
  directory. Nothing was blocked.

## [0.9.0] — 2026-08-01 — S9: methodology

### Added

- **`METHODOLOGY.md`** — how to load-test a Canton application: choosing the
  load model, what to do before measuring, the traps (coordinated omission,
  averaging percentiles, measuring your own generator, warm-up poisoning a
  baseline, pool exhaustion, inventing a limit from noise), how to read the
  results, a Canton-signal interpretation table, a worked end-to-end run and a
  pre-flight checklist. Every trap is grounded in a wrong answer this project
  actually produced and then fixed.

### Notes

- With S9 done, the only outstanding roadmap item is the **multi-participant
  half of S6**, which is blocked on a Canton distribution rather than on
  design.

## [0.8.0] — 2026-08-01 — S8: release & safety

### Added

- **Safety guardrails** (`src/safety.ts`) — the counterweight to a tool whose
  job is saturating a ledger:
  - Non-local participants are **refused by default**; driving one requires
    `--allow-remote`, and even then the plan and target are printed first.
  - Default caps on offered rate (1000/s), total operations (1,000,000) and
    duration (1h). Every refusal names the exact flag that lifts it
    (`--max-rate` / `--max-ops` / `--max-duration`).
  - `--dry-run` prints the full plan — target, setup command count, arrival
    profile, workers, and an estimated **total commands submitted** — without
    submitting anything or booting a sandbox.
  - All checks run *before* any command is sent, so a mistake costs nothing.
- **Versioned workload configs** — an optional `version` field, validated;
  a file from a newer format is rejected with a clear message instead of being
  misinterpreted.
- `canton-stress --version` / `--help`.

## [0.7.0] — 2026-08-01 — S5: test modes

### Added

- `--mode ramp|soak|spike|stress` over a new primitive: a **time-varying
  arrival rate**, plus duration-driven runs and time-stamped results.
- Per-mode verdicts: latency **knee** and throughput **cliff** (ramp), **drift**
  (soak), **recovery time** (spike), **breaking point + dominant failure mode**
  (stress). Every analysis returns nothing when the data does not support a
  conclusion rather than inventing a capacity number.
- Time-series section in the HTML report (offered vs committed vs p99) and
  console sparklines.

### Fixed

- **Transport failures no longer abort a run.** At ~400 ops/s a raw
  `fetch failed` propagated out of the runner and discarded ~11,400 samples —
  destroying the observation a stress test exists to make. Now recorded as
  `TRANSPORT_FAILURE` data, classified as a rejection.
- **Warm-up no longer poisons baselines.** The first bucket of a sandbox run
  carried the highest p99 of the whole test (7.4s vs a ~400ms steady state),
  making any knee undetectable and any spike recovery look instant. Modes now
  discard ~10% of the window, and the spike baseline is taken from the buckets
  immediately before the burst.
- `findCliff` no longer reports a cliff for a flat run; a cliff now requires
  evidence that offered load actually rose.

## [0.6.0] — 2026-08-01 — S6: distributed load generation

### Added

- `--workers n` — setup runs once on the coordinator, then the measured window
  is fanned across worker processes which return **raw samples**.
- `--api url1,url2` — workers spread over participants round-robin, with
  per-worker and per-endpoint reporting.
- Merging pools raw samples and **recomputes percentiles** (never averages
  them) over the **union** wall-clock window.

### Fixed

- Start barrier moved to the measured window's edge: workers previously
  signalled ready on *receiving* a job, so "go" began a variable amount of
  ACS-snapshotting — measured at 1031ms of start skew across a 2.4s window,
  now ~1ms.

### Known limits

- Multi-participant targeting is exercised only against *independent*
  endpoints. One Canton network with several participants sharing a
  synchronizer, and party-to-participant placement, are not implemented.

## [0.5.0] — 2026-07-31 — S4: Canton instrumentation

### Added

- **Hot-contract attribution** — contracts ranked by races *lost*, plus a
  concentration figure separating a single bottleneck from broad contention.
- Per-party and per-operation latency breakdowns.
- Read-side lag sampling (`--lag-sample`).
- CIP-0104 **traffic cost** estimation via `interactive-submission/prepare`,
  taken out-of-band so it cannot perturb the run.
- CI gates `--max-hotspot-share` and `--max-read-lag`.

### Known limits

- Traffic reads **UNMETERED** on a sandbox (no traffic control configured);
  real figures need a traffic-metered synchronizer.
- Read-side lag reads 0 on a sandbox; PQS proper (Scribe) is not deployed.

## [0.4.0] — 2026-07-30 — S2: real-app setup

### Added

- A **setup program**: ordered steps with `id` bindings, `count` repetition,
  per-step `actAs`, and `$ref:<id>` placeholders chaining a factory choice's
  returned contract id into later steps and into the measured mix.
- `submitAndWaitForTree` — reads created contract ids / `exerciseResult` back
  out of a transaction.
- `--setup-only`, `check <workload.json>`, and `examples/settlement-app`.

## [0.3.0] — 2026-07-29 — S7: reporting and CI gates

### Added

- Self-contained HTML report; multi-run `--sweep` with throughput/latency
  curves; SLA gate on `run` and regression gate on `report --baseline`;
  GitHub Actions workflows.

## [0.2.0] — 2026-07-29 — S1 + S3: workloads and measurement

### Added

- Declarative workload files (party population, weighted operation mix).
- Open-model (constant-arrival-rate) load that is
  **coordinated-omission-correct**, alongside the closed model.

## [0.1.0] — initial

- MVP: create/transfer presets, concurrency, latency percentiles, contention
  classification, `--sandbox`.
