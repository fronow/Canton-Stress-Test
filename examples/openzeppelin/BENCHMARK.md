# Benchmark: OpenZeppelin's Canton token template

**Third-party code we did not write.** `OpenZeppelin/canton-token-template`
(AGPL-3.0), a reference implementation of the Canton Network Token Standard
(CIP-0056). We depend on its DAR; none of its source is vendored here.

**What was measured:** the standard interface choice
`TransferFactory_Transfer` from `splice-api-token-transfer-instruction-v1`,
exercised against their `SimpleTokenRules` factory — the transaction an
interoperating wallet actually submits.

**Environment:** single-participant `daml sandbox`, in-memory, one laptop
(6-core i7-8750H). **Floor numbers, not production capacity.** The transferable
finding is the *shape* of the result and what limits it.

---

> ### ⚠ The headline number below is a SINGLE-WALLET figure
>
> This run used one sending wallet, so all 400 holdings came from the same pool
> and every concurrent transfer contended with itself. **~15/s is not the
> registry's capacity** — with 8 independent sending wallets the same code does
> **44/s**, and contention falls from 48.8% to 6.2%.
>
> The finding below still holds: the factory never conflicts, and the limit is
> input-holding selection. See **[BENCHMARK-SCALING.md](BENCHMARK-SCALING.md)**
> for the corrected numbers.

## Headline

> OpenZeppelin's token template settles **~15–17 standard transfers/second**
> with **p99 ≈ 400–800 ms**, and stops scaling at **~22 transfers/s offered**.
> Throughput is bounded by **input-holding selection**, not by the factory: the
> dominant failure at every load level is `CONTRACT_NOT_FOUND` — a second
> transfer reaching an input that a concurrent transfer had already archived.

Their implementation is deliberate about this. `Rules.daml` archives every
input *first*, commented "first mutation for contention guarantee". The
benchmark shows what that guarantee costs under concurrency: correctness is
preserved, and the price is paid in retries.

## The runs

### 1. Steady state

Closed model, concurrency 8, 60 transfers, 400-holding pool. The sender submits
**alone**, reaching the factory by explicit disclosure — as a wallet does:

| | |
|---|---|
| committed | 57 / 60 |
| throughput | **15.0 transfers/s** |
| latency | p50 402 ms · **p99 1172 ms** |
| contention | 3.3% |
| dominant failure | `CONTRACT_NOT_FOUND (2×)` |

#### What disclosure costs

The same workload with the admin **co-submitting** instead of disclosing (the
factory is then visible because a stakeholder is on the submission):

| | co-submitted | **disclosed (realistic)** |
|---|---|---|
| throughput | 15.5/s | 15.0/s |
| p99 | 803 ms | **1172 ms** |

> **RETRACTED.** This section previously concluded that disclosure "costs ~3%
> throughput and raises p99 by ~45%". **That was not a measurement and the
> claim is withdrawn.**
>
> The run was **60 transfers**. At n=60 the "p99" is the single worst
> observation, so 803 ms against 1172 ms compared one garbage-collection pause
> with another. A percentile needs roughly `10 × 100/(100−p)` samples before it
> carries information — ~1,000 for a p90, ~10,000 for a p99 — and that rule is
> now applied throughout this project.
>
> The tell was in the shape and was missed: a ~576-byte marshalling cost would
> appear at the median and in throughput proportionally, not as a tail-only
> spike next to a 3% throughput difference. At n=60 the medians were identical
> at ~400 ms, and that was the honest result.
>
> Thanks to Kevin at K2F Labs, who spotted it from the shape alone.

What survives without overreaching: the blob is ~576 bytes on every transfer,
and against a MainNet envelope of roughly 35 KB that is about 1.6% of the
traffic a submission pays for — **a fee item, not a latency item**. Measuring it
properly needs an interleaved A/B at ≥10,000 operations, which has not been run.

### 2. Ramp — where RANDOM SELECTION stops scaling

> **Read the ~22/s below as a property of the input-selection strategy, not as a
> capacity limit.** This ramp uses random selection, so the load it sheds is the
> wallet colliding with holdings it already spent. On the same machine and the
> same registry, giving each in-flight submission a distinct input commits 240
> of 240 at **42.1/s** (see *Selection strategy*). An earlier version of this
> file presented ~22/s as where the system stops scaling; that was wrong, and it
> understated the registry by roughly half.

Open model, 4 → 30 transfers/s over 45 s, 1200-holding pool (deep enough that
the pool is not the limit):

```
ramp: throughput cliff at ~22 ops/s offered (peaks at 17 committed/s)
      — but 26.5% of offered load was refused (CONTRACT_NOT_FOUND (195×))

offered → throughput / p99 by 3s bucket:
  ▂▄▄▅▅▇▅▇▇█▇▇▇▇   throughput (max 17/s)
  ▇▇▇█▇▇▇▇▇▇▇▇▇▇   p99 (max 443ms)
```

Latency stays flat while throughput plateaus: the registry **sheds** excess
load rather than queueing it. For an SLA that is the good failure mode — the
transfers that succeed stay fast.

### 3. The measurement trap, demonstrated

The same ramp against a **400**-holding pool reports something quite different:

```
throughput 5.9/s, 77.4% contention
  ▃▇▇█▇▆▇▅▄▃▃▁▁▁   throughput — climbs, then collapses
```

That collapse is the *pool* emptying (1581 attempts, 400 holdings), not the
registry failing. Quoting 5.9/s as this app's capacity would be wrong. See
`METHODOLOGY.md` §3 — sizing the contract pool for the whole run is a
precondition for a meaningful number, and this is what it looks like when you
get it wrong.

## Settlement (DvP): the allocation path

The same registry also implements `AllocationFactory`. `AllocationFactory_Allocate`
is the flow institutional settlement actually uses: a sender allocates an asset
to a settlement identified by a reference, naming an executor and deadlines. Per
allocation the factory archives the inputs, creates a `LockedSimpleHolding` held
by the admin until `settleBefore`, creates a `SimpleAllocation`, and returns
change — strictly more work than a transfer.

Closed model, concurrency 8, 60 allocations, 400-holding pool:

| | transfer | **allocation (DvP)** |
|---|---|---|
| committed | 57 / 60 | **57 / 60** |
| throughput | 15.0/s | **15.0/s** |
| p50 / p99 | 402 / 1172 ms | **382 / 1184 ms** |
| contention | 3.3% | **5%** |

(both with explicit disclosure, sender submitting alone)

**Allocation costs no throughput.** It does strictly more work per operation and
lands in the same band. That is the useful result: the ceiling is not set by the
work inside the choice, it is set by **input-holding selection** — the same
`CONTRACT_NOT_FOUND` collisions that bound the transfer path.

Ramped 4 → 30/s over 45 s against a 1200-holding pool, the allocation path peaks
at **17–19 allocations/s**, matching transfers.

### A caveat on single-ramp "cliff" numbers

Two runs of that ramp differing only in RNG seed:

| seed | committed | contention | verdict |
|---|---|---|---|
| 42 | 544 | 26.4% | cliff at ~22/s offered, peak 17/s |
| 7 | 538 | 27.0% | **no clean cliff** — still climbing at 30/s, peak 19/s |

Same throughput band, but the *cliff* is seed-sensitive at this sample size:
in the second run throughput was still rising when the ramp ended, and the tool
declined to report a cliff rather than nominating the largest bucket it saw.
Treat a single 45-second ramp as bracketing a range, not as a precise limit —
and note that the numbers a tool refuses to produce are as informative as the
ones it does.

## Comparison with a minimal registry

The same benchmark against a ~90-line registry implementing only the transfer
interface (`examples/token-standard/`):

| | minimal registry | OpenZeppelin template |
|---|---|---|
| steady throughput | ~19/s | ~15.5/s |
| ramp peak | 18/s | 17/s |
| p99 | ~750 ms | ~800 ms |
| work per transfer | archive inputs, create receiver + change | 20 invariant checks, 3-way dispatch, archive inputs, create locked holding + transfer instruction + change |

**~15% less throughput for substantially more work per transfer** — invariant
checking, multi-instrument support, lock handling and the two-step protocol.
That is a reasonable price, and it is the kind of comparison a team choosing an
implementation actually wants.

## What the runs exercise

With an empty choice context and `sender ≠ receiver`, the transfer takes the
**two-step path**: archive the inputs, create a `LockedSimpleHolding` plus a
`SimpleTransferInstruction`, return change. The allocation workload exercises
`AllocationFactory_Allocate` (above). Not covered, and good follow-up
workloads: self-transfer (merge/defragment), direct transfer via a
`TransferPreapproval` supplied in the choice context, and the settlement
lifecycle beyond allocation (`Allocation_ExecuteTransfer`).

## Honest scope

- **SDK.** Their `daml.yaml` pins 3.4.10; built here against 3.4.11 (patch-level,
  same `--target=2.1`).
- One laptop, one participant, in-memory storage.
- CIP-0104 traffic reads **UNMETERED** — a sandbox has no traffic control
  configured, so the synchronizer reports no cost. That is *unmeasured*, not
  free, which is why it is never reported as a measured zero.

  **Cost-per-transfer is no longer unanswered**, though. The prepared
  transaction's size is a real measurement on any participant, so
  `--traffic-price` gives a cost per operation without a metered synchronizer:
  this registry is **13,955 B, about $0.80 per transfer** at $60/MB. It is a
  lower bound — the sequenced confirmation request adds encrypted views per
  informee. See [envelope/BENCHMARK-ENVELOPE.md](envelope/BENCHMARK-ENVELOPE.md).

## Reproducing

```powershell
git clone --depth 1 https://github.com/OpenZeppelin/canton-token-template.git <your checkout of canton-token-template>
cd <your checkout of canton-token-template>          # set sdk-version to your installed 3.4.x
daml build

cd <this repository>
node src/cli.ts check examples/openzeppelin/workload-transfer.json

node src/cli.ts run <your checkout of canton-token-template>/.daml/dist/simple-token-0.1.0.dar `
  --workload-file examples/openzeppelin/workload-transfer.json `
  --model closed --concurrency 8 --ops 60 `
  --sandbox --java-home "<your workspace>\tools\jdk-21.0.11+10"

node src/cli.ts run <your checkout of canton-token-template>/.daml/dist/simple-token-0.1.0.dar `
  --workload-file examples/openzeppelin/workload-transfer.json `
  --model open --mode ramp --from 4 --to 30 --duration 45 --bucket 3 `
  --sandbox --java-home "<your workspace>\tools\jdk-21.0.11+10"

# settlement (DvP) — same flags, allocation workload
node src/cli.ts run <your checkout of canton-token-template>/.daml/dist/simple-token-0.1.0.dar `
  --workload-file examples/openzeppelin/workload-allocation.json `
  --model closed --concurrency 8 --ops 60 `
  --sandbox --java-home "<your workspace>\tools\jdk-21.0.11+10"
```

Raise the `holdings` step's `count` if you increase the rate or duration.
