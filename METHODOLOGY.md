# How to load-test a Canton application

> A method, not a tool manual. Everything here is either standard performance
> engineering or something this project measured the hard way — each trap below
> is one that produced a wrong answer on a real run before it was fixed. Tool
> mechanics live in [TESTING-GUIDE.md](TESTING-GUIDE.md) and
> [WORKLOAD-FORMAT.md](WORKLOAD-FORMAT.md).

---

## 1. Start from the decision, not the number

A load test is commissioned because somebody has to decide something: whether to
launch, what to size, whether an SLA is safe, whether a change made things
worse. "How fast is it?" is not a decision, and it has no answer — throughput
depends on the workload, the party population, the contract pool, the topology
and the load model.

Write the question down first. Good ones look like:

- *Can we hold p99 < 2s at 50 settlements/sec?* → **open model**, steady rate, SLA gate.
- *What is our ceiling before we must shard?* → **ramp**, find the knee.
- *Will an eight-hour batch day degrade?* → **soak**, look for drift.
- *Does the 09:00 open break us?* → **spike**, measure recovery.
- *Did this PR make it worse?* → fixed workload + **regression gate** on a baseline.

If you cannot say which decision the run informs, you will get a number nobody
can act on.

## 2. The two load models — pick deliberately

|  | closed | open |
|---|---|---|
| what is fixed | N operations in flight | arrivals per second |
| answers | "how fast can it go?" | "does it hold at N/s?" |
| latency means | service time | time from *intended* arrival |
| self-limiting | yes — it waits for the system | no — a backlog accumulates |

**A closed model cannot tell you whether you meet an SLA.** It slows down when
the system does, so it always looks healthy. If your question mentions a rate
("12k settlements/hour"), you need the open model.

The reverse is also true: a closed model is the honest way to ask "what is the
maximum" without a queue-depth argument, and it is the right model for a
concurrency-sensitive contention study.

Ramp, spike and stress are open-model by construction — they vary the *offered*
load, and a closed model has none to vary. Soak works in both.

## 3. Before you measure

**Warm up, and discard it.** The first seconds of a JVM-backed ledger are JIT,
connection setup and cold caches. Measured here: the **first bucket of a run
carried the highest p99 of the entire test — 7.4s against a ~400ms steady
state**. Left in the sample it does more than skew an average; it becomes the
baseline every later comparison is made against, and then no real latency knee
can ever exceed it. Modes discard ~10% of the window by default; for hand-rolled
runs use `--warmup`.

**Size your contract pool for the whole run.** If each measured operation
consumes a contract created during setup, a long run exhausts the pool and you
measure the exhaustion. Measured here: a 45s ramp against a 24-holding pool
reported a "throughput cliff at 3.3 ops/s" with 97% contention. Nothing about
that number describes Canton. Either use operations that create their own
subjects, or size the pool for the full duration.

**Make the workload representative.** Reproduce the transaction *mix* and the
party population you actually run — "70% transfer / 20% split / 10% redeem
across 500 parties", not a single hot loop. A profile that is not yours produces
a capacity number that is not yours.

**Decide what you are varying.** One dimension at a time: concurrency, or
arrival rate, or party count, or pool depth. A run where two things changed
explains nothing.

## 4. The traps

Each of these produced a wrong answer on a real run in this project.

### Coordinated omission

When the system stalls, a naive load generator stops *sending*, waits, and then
reports only the service time of whatever it sends next. The queue the user
actually sat in disappears from the data. This is the single most common reason
a load tool's tail latency is fiction.

The fix is to fix each operation's *intended* arrival time from the schedule and
charge latency from there, whatever time it was actually dispatched. Measured
consequence: an open-model run targeting 15/s achieved 4.2/s and reported
**p99 ≈ 10s** — a naive tool would have reported sub-second service times for
the same run.

### Averaging percentiles

p99 is an order statistic of a sample. The p99 of two pooled populations is not
the mean, the max, or any other function of their separate p99s. Merging
summaries across workers, shards or runs is arithmetic that produces a
confident, wrong number. Pool the **raw** samples and recompute.

Same trap in time: a run's overall p99 is not the average of its per-bucket
p99s.

### Measuring your own load generator

Above a few thousand operations per second, one process spends its time on
HTTP and JSON rather than on the ledger, and every number it reports is a
number about the load generator. Measured here: a single process topped out at
**2665 ops/s**; four processes reached **5137/s** against the same target — the
first figure was never about the ledger at all.

Symptoms: throughput flat while CPU on the generator is pinned; latency rising
with no corresponding ledger-side signal; `TRANSPORT_FAILURE` in the failure
mode. Fix by adding `--workers`, or by moving generation off the box under test.

Corollary: **a local sandbox cannot demonstrate generator scaling**, because at
~10–60 ops/s the sandbox is the bottleneck. To measure the generator you need a
target faster than it.

### Mistaking your own limits for the system's

Related but distinct: when the run itself breaks, say *which side* broke.
`PARTICIPANT_BACKPRESSURE` is the ledger refusing work — a real capacity answer.
`TRANSPORT_FAILURE` is the generator's sockets giving out — your measurement
apparatus failed, and the run says nothing about the app. Reporting the second
as capacity is how tools lose credibility.

### Letting a crash eat the evidence

A stress test exists to observe a breaking point, so it must survive reaching
one. Measured here: at ~400 ops/s a raw `fetch failed` propagated out of the
runner and **discarded ~11,400 collected samples** — destroying exactly the
observation the run was for. Failures at the limit are data; record them.

### Inventing a limit from noise

A detector that always finds a knee will find one in a flat line. Prefer
reporting *nothing*:

```
ramp: no clean knee or cliff between 2 and 40 ops/s — capacity is above this
      range, so ramp higher to find it
```

That is a more useful output than a fabricated number, and it tells you what to
do next. Every analysis in this tool returns nothing when the data does not
support a conclusion — a flat run yields no cliff, a single outlier bucket
yields no knee.

## 5. Reading the results

**Percentiles, never means.** A mean latency hides the tail, and the tail is
what an SLA is written against. Read p50 *and* p99: a large gap is queueing, a
small gap at a high value is uniform slowness — different problems.

**Committed vs offered.** Throughput is committed transactions per second.
Attempts that raced and lost are not throughput; they are the contention signal.
A run reporting "100/s attempted" and "60/s committed" has a 40% failure story
you must explain before quoting either number.

**Contention is a distribution, not a rate.** A global "46.7% contention" can be
two different worlds. Measured here, that figure decomposed into healthy
settlements at 8.8% and one registry contract losing **96.2%** of its races,
carrying **89.3% of all contention in the run**. The global rate said "it's
slow". The attribution said "here is the contract to change".

**Check the shape over time.** A single summary cannot distinguish a steady
system from one that degraded halfway through. Look at the time series before
trusting any aggregate.

## 6. Canton-specific interpretation

| signal | what it means | what to do |
|---|---|---|
| **contention** (`LOCAL_VERDICT_LOCKED`, `CONTRACT_NOT_FOUND`) | two transactions raced on the same contract; one lost | look at *which* contract — see concentration below |
| **hotspot concentration near 1** | one contract is the bottleneck | restructure that contract: shard it, make the choice non-consuming, or remove it from the hot path |
| **hotspot concentration near 0, contention high** | broad, structural contention | the workload itself is too tightly coupled; revisit the data model |
| **`PARTICIPANT_BACKPRESSURE`** | the participant is refusing work — its queues are full | this is your capacity answer; lower the offered rate or scale the participant |
| **`TRANSPORT_FAILURE`** | the load generator's sockets gave out | your apparatus failed, not the app; add `--workers` or lower the rate |
| **read-side lag growing** | the read path is falling behind commits | anything querying the ACS is serving stale data; matters for read-your-writes |
| **traffic cost** (CIP-0104) | what the load costs in sequencer traffic | capacity has a price; budget it per throughput level |
| **`unmetered` traffic** | no traffic control on this synchronizer | a sandbox reports 0 — this is not "free", it is "not measured" |

Two Canton facts that regularly cost people a day:

- **Visibility is not authorization.** A choice that fetches a contract the
  submitter is not a stakeholder of fails `CONTRACT_NOT_FOUND` even when the
  Daml authority model permits the fetch — the submitting participant genuinely
  cannot see it. Add the party that can (usually a custodian or operator) as a
  co-submitter.
- **Every party sees its own projection.** A global percentile can hide one
  party carrying the whole tail. Read the per-party breakdown before concluding
  the system is uniformly healthy.

## 7. A worked run

The question: *what can the settlement app commit, and what limits it?*

**Step 1 — validate the workload offline.** Costs a second; catches a mistyped
`$ref` before a sandbox boot.

```
node src/cli.ts check examples/settlement-app/workload.json
```

**Step 2 — see what it would do.** Nothing is submitted; no sandbox is booted.

```
node src/cli.ts run <dar> --workload-file <w.json> --mode ramp --to 60 --duration 90 --dry-run
```

Check the **estimated total commands** against what the target can absorb. If
that number surprises you, stop here.

**Step 3 — drive the app into a loadable state and confirm it.**

```
node src/cli.ts run <dar> --workload-file <w.json> --setup-only --sandbox --java-home <jdk>
```

It should report the bindings it created (`accounts: 6`, `holdings: 24`). If a
pool is smaller than your intended run length, fix it now — see §3.

**Step 4 — a steady run, to get a baseline and a feel for the failure mix.**

```
node src/cli.ts run <dar> --workload-file <w.json> --model closed --concurrency 8 --ops 60 --sandbox ...
```

Read the outcome mix before the latency. 55% contention on a 24-holding pool is
a *pool* finding; deepening it to 120 moved the same workload from 8.1/s to
18.8/s and from 55% to 21.7% contention. That is one dimension varied, and a
real answer: pool depth was the limit, not the participant.

**Step 5 — ramp to find the edge.**

```
node src/cli.ts run <dar> ... --model open --mode ramp --from 10 --to 200 --duration 60
```

If it reports no knee, ramp higher — the tool will say so. When it reports load
shedding with `PARTICIPANT_BACKPRESSURE`, you have found the participant's
limit.

**Step 6 — confirm the shape you care about**: `--mode spike` for burst
recovery, `--mode soak` for drift, `--mode stress` for the breaking point and
its failure mode.

**Step 7 — freeze it as a gate.**

```
node src/cli.ts run <dar> ... --min-throughput 15 --max-p99 2000 --max-hotspot-share 50 --report run.json
node src/cli.ts report run.json --baseline baseline.json --max-throughput-drop 10
```

A capacity answer that is not defended by a gate decays within a quarter.

## 8. Checklist

Before you believe a number:

- [ ] The question it answers is written down.
- [ ] The load model matches the question (rate → open).
- [ ] Warm-up is discarded.
- [ ] The contract pool survives the whole run.
- [ ] Only one dimension changed from the comparison run.
- [ ] Latency is coordinated-omission-correct.
- [ ] Percentiles were recomputed from raw samples, not averaged.
- [ ] The generator was not the bottleneck (or you have shown it was not).
- [ ] Failures are attributed to the right side (backpressure vs transport).
- [ ] Contention is read as a distribution, not just a rate.
- [ ] The time series was inspected, not only the summary.
- [ ] The result is defended by a gate.
