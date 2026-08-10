# canton-stress — design & complexity

> A load / performance / stress-testing harness for **Canton applications**
> (app-level, not core protocol). Drives realistic high-concurrency, multi-party
> transaction workloads at an app's DARs on a real ledger and measures how it
> performs — throughput, latency percentiles, contention, and where it breaks.

## 1. The concept

Give canton-stress an app's `.dar`(s) and a workload description. It:

1. allocates a population of parties,
2. submits transactions concurrently at a controlled rate / concurrency,
3. measures, per operation: submit→commit **latency** (p50/p95/p99/max),
   **throughput** (tx/s), and **outcome mix** (committed / contention-rejected /
   other-rejected),
4. ramps the load to find the **throughput cliff** and latency knee,
5. emits a report (JSON + self-contained HTML with graphs) and, for CI, a
   pass/fail verdict against SLA thresholds.

It answers the question every institutional Canton app eventually asks and today
has no tool for: **"will this hold its latency/throughput SLA under real
concurrent load, and where does it fall over?"**

## 2. Why this is the right project to reuse our tech

canton-stress is the daml-fuzz executor pointed at a different goal. The shared
foundation (already built and tested in `../tool`):

- **DAR introspection** — enumerate templates, choices, argument types.
- **Transaction generation** — valid, parameterized, multi-party commands.
- **Ledger client** — submit over the JSON Ledger API; party management with
  run-unique hints; ACS queries.
- **Deterministic seeding** — reproducible runs.

Roughly **50–60% of the infrastructure is shared.** The fuzzer asks "does any
sequence break an invariant?"; the harness asks "how fast, and where does it
degrade?" Different oracle, different execution model — same plumbing.

## 3. Canton-specific realities (what makes this non-trivial and valuable)

A naive load tester would mislead on Canton. Getting these right is the value:

- **Optimistic concurrency / contention.** Canton rejects transactions that
  conflict on a contract (a stakeholder reads/consumes a contract another tx
  already changed). Under load this shows up as `CONTENTION`/`LOCAL_VERDICT`
  rejections, not slowness. A credible harness must **classify contention
  rejections separately** from throughput and report the contention rate — this
  is often the real scaling limit for a hot contract, and measuring it is a
  headline feature.
- **Hot-contract / key contention.** Workloads that funnel through one shared
  contract (a registry, a config, a pool) serialize. The harness should detect
  and surface hotspots.
- **Sequencer traffic & fees (CIP-0104).** Canton meters traffic; load has a
  cost. Reporting **traffic/cost per throughput level** is a Canton-unique,
  high-value metric no generic load tool has.
- **Multi-domain / synchronizer latency.** Commit latency depends on the
  synchronizer; cross-domain workflows add rounds. Later phases can vary this.
- **Backpressure & in-flight limits.** Participants apply command dedup and
  max-in-flight limits; the harness must respect/observe backpressure rather
  than hammer blindly and misreport.
- **PQS / indexer lag.** Read-side (Participant Query Store) can lag under write
  load; measuring read staleness under load is a distinct, useful signal.
- **Per-party projection.** Each party sees only its projection; latency can
  differ per party. Measuring per-party is more honest than a global number.

## 4. Complexity assessment

**Medium-high, but front-loaded risk is already retired by the fuzzer work.**

| Component                                                           | New vs. reused | Difficulty               |
| ------------------------------------------------------------------- | -------------- | ------------------------ |
| DAR introspection                                                   | reused         | —                        |
| Transaction generation                                              | reused (adapt) | low                      |
| Ledger client / party mgmt                                          | reused         | low                      |
| **Concurrency / parallel submission engine**                        | new            | medium                   |
| **Precise latency measurement** (submit→commit, percentiles)        | new            | medium                   |
| **Contention classification**                                       | new            | medium (Canton-specific) |
| **Workload modeling** (declarative scenarios, op mix, arrival rate) | new            | medium-high              |
| **Ramp / soak / spike controllers**                                 | new            | medium                   |
| **Metrics aggregation + report/graphs**                             | new            | medium                   |
| **Traffic-cost + PQS-lag instrumentation**                          | new            | medium (Canton-specific) |
| Multi-participant / multi-domain                                    | new            | high (later phase)       |

Nothing here is research-hard; it is solid systems engineering plus Canton
domain knowledge. The hardest correctness risk (talking to a real ledger,
introspecting arbitrary DARs, generating valid multi-party txns) is already
solved in `../tool`.

## 5. Phases

**Phase 1 — Core load engine (~2 months)**

- Concurrent submission with controlled concurrency; submit→commit latency with
  percentiles; throughput; outcome mix (committed / contention / other).
- Single declarative workload (a create + a repeated exercise) over a party
  population; deterministic seed.
- JSON + self-contained HTML report.
- _Metric:_ on a reference app, produce stable throughput/latency numbers across
  runs (± small variance); contention rejections correctly classified.

**Phase 2 — Workload modeling + contention analysis (~2 months)**

- Declarative scenario format: parties, operation set with weights, arrival
  rate, think-time, contract lifecycle.
- Contention-rate measurement and **hot-contract detection**; per-party latency.
- _Metric:_ reproduce a known contention hotspot on a sample app and report it.

**Phase 3 — Scaling modes + cost + CI gating (~2 months)**

- **Ramp** (increase load to find the cliff), **soak** (long-run, detect
  degradation/leaks), **spike** (burst recovery) modes.
- Latency-vs-load curves; throughput cliff detection.
- **Traffic/cost reporting (CIP-0104)** per load level; optional **PQS lag**.
- Regression baselines: compare two runs; **fail CI** on SLA/regression (reuse
  the fuzzer's non-zero-exit gate pattern + GitHub Action).
- _Metric:_ a CI job that gates a PR on a latency/throughput SLA.

**Phase 4 — Multi-participant / multi-domain + hardening (optional / maintenance)**

- Drive load across multiple participants and synchronizers; dashboards; docs;
  ongoing SDK-compatibility maintenance.

## 6. How the stress tests should actually be done (methodology)

- **Define a workload, don't just random-fuzz.** Performance testing needs
  _representative_ scenarios: e.g. "N holders each doing a transfer every T ms
  against a shared registry." The generator produces valid txns; the workload
  layer controls the mix and rate.
- **Warm up, then measure.** Discard a warm-up window (JIT, caches, PQS
  priming), then measure the steady state.
- **Vary one dimension at a time** — concurrency, party count, or live-contract
  count — and plot the response to find the knee/cliff.
- **Four canonical modes:**
  - _Load:_ steady rate at/below expected capacity → SLA validation.
  - _Stress:_ push past capacity → find the breaking point and failure mode.
  - _Soak:_ sustained load for hours → memory/latency drift, PQS lag growth.
  - _Spike:_ sudden burst → backpressure and recovery behavior.
- **Report the right numbers:** percentiles (never just the mean), throughput,
  contention rate, error taxonomy, and cost. Means hide tail latency, which is
  what institutional SLAs care about.
- **Deterministic & reproducible:** seeded workloads, pinned party counts, so a
  regression is a real regression, not noise.
- **Isolate the app under test:** fresh parties per run (Canton privacy gives run
  isolation, exactly as the fuzzer relies on), a clean or defined initial state.

## 7. What we can point it at (targets)

Any Canton app with DARs and a reachable participant — the market is broad:

- **CIP-0056 Token Standard implementations** — transfer throughput, allocation
  and registry contention (the many token proposals: #580, #453, #267, #232…).
- **daml-finance-based apps** — settlement, holdings, DvP throughput.
- **Splice / Canton Coin** flows.
- **The DeFi cohort** that dominates the dev fund — DEXes, perps, lending,
  payment streaming (#528, #303, #170, #73, #416…) all need latency/throughput
  validation before institutional use.
- **The reference wallet / quickstart** as easy first targets.
- Our own `../tool/examples/sample-token` as the bundled smoke target.

## 8. Relationship to existing tools (checked against the full dev-fund set)

- **daml-fuzz #52 / DamlCov #323** — correctness & coverage. Different axis
  (does it break? / is it covered?) vs. (how fast? where does it degrade?).
  Complementary, not competing.
- **#379 Transaction Profiler** — _analyses existing_ transactions; canton-stress
  _generates_ load. Adjacent, distinct.
- **DA scalability/performance (accepted)** — **core-protocol** performance. This
  must be positioned strictly as **app-developer tooling**, not protocol work,
  to avoid overlap. (This is the main positioning risk.)

## 9. Interface: terminal-first, with a generated visual report

**It's a CLI/terminal tool at its core, with a rich generated HTML report — not
a live web app.** That's the right answer for three reasons:

1. **It has to run headless in CI.** The whole point of Phase 3 is gating a PR on
   a latency/throughput SLA. A performance tool that needs a human clicking a UI
   can't do that. Terminal + exit code (the pattern already added to daml-fuzz)
   is non-negotiable for the CI story.
2. **It must be scriptable and reproducible.** Seeded, flag-driven runs that
   produce machine-readable JSON — so a regression is a diff, not a screenshot.
3. **The visual value lives in the *report*, not a dashboard.** Load tests
   produce rich data (latency-vs-load curves, percentile distributions,
   contention over time, throughput cliffs) that is far more useful seen as
   graphs. So the tool emits a **self-contained HTML report with embedded
   charts** — no server, no external assets — exactly the pattern daml-fuzz
   already ships (`src/render.ts`). You open a file; there's nothing to host.

So the shape is:

```
canton-stress run <dar> --workload w.json --ramp ...   # headless, JSON + exit code
canton-stress report run.json --out report.html        # self-contained charts
```

**What it is NOT (for v1):** a live, real-time web dashboard backed by a running
server. That adds a frontend app + a service to host and maintain, for little
gain on a CI/dev tool — and it would break the "clone and run, nothing to host"
property. A live dashboard is a reasonable **Phase 4 optional** if adopters
specifically ask for one; it should never be the primary interface.

This choice also maximizes reuse: the CLI, the JSON-report-then-HTML-render
split, and the self-contained-page renderer all come straight from `../tool`.

> If a hosted/interactive UI ever *is* wanted, keep the CLI as the engine and
> put any UI on top of its JSON output — never make the UI the tool.
