# Wallet-count scaling: OpenZeppelin Canton token template

**This supersedes the headline number in [BENCHMARK.md](BENCHMARK.md).** That
run used a single sending wallet, so its ~15 transfers/s is what one wallet
sustains while contending with itself — not the registry's capacity.

Prompted by a question from Bernhard Elsner (CPO, Digital Asset) on the Canton
forum: *how many wallets were sending in parallel, with how much overlap, what
is the UTXO selection logic, and how do the numbers scale with more wallets?*
The first three had answers; the fourth did not, so it was measured.

---

## The load profile of the original run

The thing worth being explicit about, because it determines everything:

- **One sending wallet, one receiving wallet.** `sender: $p0`, `receiver: $p1`.
- **All 400 holdings owned by that single sender.** Every concurrent submission
  drew from the same pool, so overlap was **total** — the maximum-contention
  case, not a representative profile.
- **Input selection: a uniform random pick of a single holding** from the pool
  (`$ref:holdings[*]`). Each holding is 1000.0 against a 1.0 transfer, so one
  input always covers the amount: no multi-input selection, no coalescing, no
  merge/defragment step.

Random selection over a shared pool is close to the worst case for collisions,
which is why `CONTRACT_NOT_FOUND` dominates every failure at every load level.

## Method

`gen-scaling.cjs` generates one workload per wallet count. Each sender gets its
**own** pool of 150 holdings and its **own** receiver, so wallets never touch
each other's holdings. The only variable is how many independent wallets the
same load is spread across.

Two sweeps, because they answer different questions.

## 1 · Offered load held constant

Concurrency 8 throughout, 120 transfers per run.

| wallets | committed | throughput | contention |
|---|---|---|---|
| 1 | 88 / 120 | 15.2/s | 25.8% |
| 2 | 107 / 120 | 16.5/s | 10.0% |
| 4 | 115 / 120 | 18.5/s | 4.2% |
| 8 | 120 / 120 | 19.0/s | 0% |

More wallets simply convert failures into successes. **Contention reaches zero
and nothing is lost**, but throughput barely moves — because the offered rate
never rose. This sweep isolates the contention mechanism; it cannot find a
ceiling.

## 2 · Offered load scales with wallet count

Per-wallet concurrency held at 8 (so total concurrency is 8 × wallets), 240
transfers per run.

| wallets | committed | throughput | contention | p50 | p99 |
|---|---|---|---|---|---|
| 1 | 120 / 240 | 14.6/s | 48.8% | 350 ms | 1361 ms |
| 2 | 171 / 240 | 25.4/s | 27.5% | 451 ms | 1652 ms |
| 4 | 206 / 240 | 35.2/s | 12.9% | 692 ms | 1759 ms |
| 8 | 224 / 240 | 44.0/s | 6.2% | 1083 ms | 2366 ms |

**Three findings.**

**Contention is a property of wallet count, not of the registry** — 48.8% down
to 6.2%, falling roughly with the number of independent pools.

**The same code does 3× the throughput at 8 wallets** (14.6 → 44.0/s). So ~15/s
was never a registry ceiling; the original run was measuring its own load
profile.

**But scaling is sublinear and latency rises throughout** — p50 triples, p99
nearly doubles. A second ceiling sits above wallet contention, and on a single
in-memory participant on one laptop that is almost certainly the participant
rather than the registry. The two cannot be separated on this hardware.

## Not yet varied

Named here so the gaps are explicit rather than implied:

- **Pool depth per wallet** (held at 150 throughout).
- **Transfer size relative to holding size** — at 1.0 against 1000.0, multi-input
  selection never engages. Larger transfers would exercise it.
- **Partial overlap between senders.** Pools here are fully disjoint; real wallet
  traffic is somewhere between that and the single-pool case.
- **Selection strategy** — random vs. least-recently-used vs. a per-submission
  reservation. Expectation, stated as an expectation: this moves the number more
  than the choice of registry does. Unmeasured.

## Reproducing

```powershell
node examples/openzeppelin/gen-scaling.cjs      # writes scaling/wallets-{1,2,4,8}.json

# sweep A - offered load constant
node src/cli.ts run <path-to>/simple-token-0.1.0.dar `
  --workload-file examples/openzeppelin/scaling/wallets-8.json `
  --model closed --concurrency 8 --ops 120 --sandbox --java-home <jdk>

# sweep B - offered load scales with wallet count (concurrency = 8 x wallets)
node src/cli.ts run <path-to>/simple-token-0.1.0.dar `
  --workload-file examples/openzeppelin/scaling/wallets-8.json `
  --model closed --concurrency 64 --ops 240 --sandbox --java-home <jdk>
```

Full driver scripts and every raw run report are under
[`scaling/results/`](scaling/results/). Figures: [`docs/scaling-card.png`](../../docs/scaling-card.png),
[`docs/scaling-tables.png`](../../docs/scaling-tables.png).

## Scope

Single participant, in-memory, one laptop (6-core i7-8750H), Canton 3.4.11,
LF 2.1. Floor numbers. What transfers to a real deployment is the shape — where
the bottleneck sits and how the system behaves past it — not the absolute rate.
