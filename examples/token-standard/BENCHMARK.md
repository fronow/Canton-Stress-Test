# Benchmark: a Canton Network Token Standard registry

**What was measured:** the standard interface choice
`TransferFactory_Transfer` from `splice-api-token-transfer-instruction-v1`
(CIP-0056), exercised against a registry that implements the real `Holding` and
`TransferFactory` interfaces from the **prebuilt Splice DARs**. This is the
transaction an interoperating wallet actually submits — the choice is exercised
on the *interface* id, not on the implementation's template.

**Environment (read this before quoting any number):** a single-participant
`daml sandbox`, in-memory, on one developer laptop (6-core i7-8750H), SDK
3.4.11. These are **floor** numbers for a laptop, not production capacity. The
*shape* of the result — what limits throughput — is the transferable finding.

Registry under test: `E:\sp` (`std-spike`), ~90 lines implementing the standard
interfaces with genuine transfer logic: it conserves value (archives inputs,
creates receiver + change) and enforces that the sender owns every input.

---

## Headline

> A Token Standard registry settles **~19 transfers/second** with **p99 ≈ 750 ms**
> on a single-participant sandbox. The binding constraint is **input-holding
> selection, not the TransferFactory** — the factory's standard choice is
> nonconsuming and reusable, and never conflicts. Deepening the sender's holding
> pool from 160 to 800 cut failures from **28% to 6%** and raised throughput
> **27%**, with no change to the registry.

For a wallet integrator that is an actionable statement: your achievable
transfer rate is governed by how you select input holdings, not by the registry
you are talking to.

## The runs

### 1. Steady state, and one dimension varied

Closed model, concurrency 8, 100 standard transfers, identical in every respect
except the depth of the sending wallet's holding pool:

| holding pool | committed | contention | throughput | p99 | dominant failure |
|---|---|---|---|---|---|
| 160 | 72/100 | **28%** | 15.2/s | 762 ms | `CONTRACT_NOT_FOUND (27×)` |
| 800 | 94/100 | **6%** | 19.3/s | 754 ms | `CONTRACT_NOT_FOUND (6×)` |

The failures are **not** lock contention on the factory. They are
`CONTRACT_NOT_FOUND`: two concurrent transfers selected the same holding, and
the second arrived after it had been archived — an attempted double-spend of an
already-consumed input. Random selection over a shallow pool collides often;
a wallet with a real UTXO-selection strategy would not.

### 2. Ramp — where it stops scaling

Open model, arrival rate climbing 4 → 60/s over 60 s, 800-holding pool:

```
ramp: throughput cliff at ~28.3 ops/s offered (peaks at 18 committed/s)
      — but 63.3% of offered load was refused (CONTRACT_NOT_FOUND (1178×)),
      so the system is already past its limit in this range

offered → throughput / p99 by 4s bucket:
  ▂▅▆▆▇█▆▇▇▅▄▅▃▃   throughput (max 18/s)
  ▇▇▇▇▇█▇▇▇▇▇▇▇▇   p99 (max 459ms)
```

**Caveat, stated plainly:** this ramp attempted 1878 transfers against an
800-holding pool, so its later buckets are measuring **pool exhaustion** as much
as registry capacity — exactly the trap `METHODOLOGY.md` §3 warns about. The
trustworthy number from this run is the *peak* (18 committed/s, consistent with
the steady-state 19/s), not the tail.

## What this says about the registry

- **The `TransferFactory` is not a bottleneck.** Its standard choice is
  nonconsuming (verified live: two transfers succeeded against the same factory
  contract), so every transfer merely *fetches* it. A shared factory does not
  serialise the registry.
- **Holdings are the scarce resource.** Each transfer archives an input and
  creates receiver + change. Throughput is bounded by how fast distinct,
  unspent holdings can be supplied to concurrent transfers.
- **Latency is flat until saturation.** p99 sat at ~450–760 ms across both pool
  depths and most of the ramp; the system sheds load rather than queueing.

## A limitation this benchmark exposed — and fixed

The first run reported **100% of contention on the TransferFactory**, because
attribution keyed only on the contract an operation is *exercised on*. That was
wrong twice over: the conflicting contract is an input holding passed as an
**argument**, and the factory is nonconsuming, so it cannot conflict at all.

Two changes came out of it:

- Contracts appearing in choice **arguments** are attributed alongside the
  exercise target.
- A contract present in *every* operation is flagged as carrying no signal and
  excluded from the bottleneck verdict — a factory every transfer touches has,
  by construction, a contention rate equal to the run's overall rate.

The table now names the holdings rather than the factory:

```
hot contracts (contention by contract):
  00275b199f45… argument  1/2 lost (50%)  p99 1210.6ms
  00e718a27070… argument  1/2 lost (50%)  p99 458.7ms
```

This matters for the whole factory-shaped Token Standard family, not just this
registry.

## Reproducing

```powershell
# 1. build the registry (implements the real standard interfaces)
cd E:\sp; daml build

# 2. validate the workload offline
cd E:\canton-daml\canton-stress
node src/cli.ts check examples/token-standard/workload.json

# 3. steady state
node src/cli.ts run E:/sp/.daml/dist/std-spike-0.1.0.dar `
  --workload-file examples/token-standard/workload.json `
  --model closed --concurrency 8 --ops 100 `
  --sandbox --java-home "E:\canton-daml\tools\jdk-21.0.11+10"

# 4. ramp to the cliff
node src/cli.ts run E:/sp/.daml/dist/std-spike-0.1.0.dar `
  --workload-file examples/token-standard/workload.json `
  --model open --mode ramp --from 4 --to 60 --duration 60 --bucket 4 `
  --sandbox --java-home "E:\canton-daml\tools\jdk-21.0.11+10"
```

Vary the pool depth by editing the `holdings` step's `count` in the workload.

## Honest scope

- One laptop, one participant, in-memory storage. Not production capacity.
- The registry is a faithful but **minimal** implementation of the standard
  interfaces (~90 lines). A production registry (Amulet / Canton Coin) has far
  more logic per transfer and would be slower.
- CIP-0104 traffic cost reads **UNMETERED**: a sandbox has no traffic control,
  so the cost-per-transfer question is still unanswered.
