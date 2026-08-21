# Multi-input selection: what happens when one holding is not enough

**This extends the turnover law in [BENCHMARK-TURNOVER.md](../turnover) to
transfers that must gather several holdings.** Every earlier run here sent 1.0
out of 1000.0-value holdings, so a single input always covered the transfer and
coin-combining never engaged once. Real wallets fragment, and a fragmented
wallet has to gather several inputs per transfer.

Prompted by production data from Kevin at K2F Labs (walley.cc), whose MainNet
figures put **inputs per transfer at p50 1 and p90 3**. So this is not an exotic
regime — it is where most real transfers live, and it had never been measured.

---

## The prediction that failed

`gen-multiinput.cjs` recorded a prediction before any of these runs: if
contention is a bookkeeping effect, gathering `k` inputs should consume the pool
`k` times faster and take `k` chances of landing on something spent, so
contention should rise roughly **linearly** with `k`. A k-input transfer out of
a pool of 1200 should behave about like a single-input transfer out of 1200/k.

Pool 1200, 120 transfers, concurrency 8, only the number of inputs varying:

| inputs `k` | predicted (linear) | measured |
|---|---|---|
| 1 | 5.0% | **3.3%** |
| 2 | 10.0% | **15.8%** |
| 4 | 20.0% | **38.3%** |
| 8 | 40.0% | **63.3%** |

**The prediction was wrong from k=2 upward, and wrong in the dangerous
direction** — it under-states the damage by roughly twofold at k=4 and k=8.
Gathering k inputs is substantially worse than shrinking the pool by k.

## Why: a transfer fails if ANY of its inputs is stale

The linear model assumes the failure probabilities add. They do not. A transfer
gathering `k` inputs commits only if **every one** of them is still live, so the
survival probability is `(1 − p)^k`, not `1 − k·p`. Degradation is geometric.

Failures consume nothing — a rejected transfer spends no holdings — so the pool
is drawn down only by transfers that commit, which makes the two quantities
mutually dependent and the model a fixed point:

```
p = f / 2                      chance one input is already spent
f = k · ops · c / pool         fraction of the pool actually consumed
c = (1 - p)^k                  share of transfers that commit

  =>   c = (1 - c·k·ops / (2·pool))^k        solve for c; contention = 1 - c
```

At `k = 1` this reduces to `f/2`, the turnover law. It generalises it rather
than replacing it.

**This model was fitted to the four runs above. That makes it a curve, not
evidence** — which is why it was then pre-registered and tested on points it had
never seen.

## The out-of-sample test

Predictions recorded in [PREDICTIONS.md](PREDICTIONS.md) **before** these three
runs, along with what the discredited linear model said for the same points:

| run | `k` | pool | linear | geometric (predicted) | measured |
|---|---|---|---|---|---|
| `oos-k3` | 3 | 1200 | 15% | 28.8% | **21.7%** |
| `oos-k6` | 6 | 1200 | 30% | 56.6% | **62.5%** |
| `oos-k4-pool2x` | 4 | 2400 | 10% | 26.3% | **23.3%** |

Mean absolute error: **geometric 5.3 points, linear 17.5 points.**

`oos-k4-pool2x` is the one that matters most. It holds `k` fixed and doubles the
pool, so it tests the model where `k` and `f` move *independently* rather than
in lockstep as they do in the first table. Predicted 26.3%, measured 23.3% — the
fit is not an artifact of the two variables being confounded.

## A measurement flaw that had to be fixed first

The first version of these workloads nominated each of the `k` inputs with an
independent random draw (`$ref:holdings[*]`). That lets one transfer name **the
same holding twice**, which fails for a reason that has nothing to do with
contention — and whose likelihood *grows with k*.

That artifact has the same shape as the effect under test, so it would have been
indistinguishable from the finding. At pool 1200 and k=8 roughly 2.3% of
transfers would have carried a self-duplicate.

The fix is a selector that draws without replacement **within one command**,
`$ref:holdings[*!]` (see [WORKLOAD-FORMAT.md](../../../WORKLOAD-FORMAT.md)).
Exclusion is scoped to a single submission, never across submissions — a wallet
should not name one holding twice in a transfer, but the pool must not shrink
either, or the run would stop measuring double-spend contention altogether.

## Honest limits

- **The geometric model is post-hoc.** The pre-registered prediction here was
  the linear one, and it was refuted. Only the round-2 points were predicted in
  advance, and they were predicted from a model already fitted to round 1.
- **±7 points out of sample**, against ±2 for the fitted curve. The fitted
  figure flatters; the honest number for prediction is ±7.
- **n = 1 per point.** These runs are known to be seed-sensitive at this sample
  size, so ±7 is consistent with seed noise, and three runs cannot separate
  model error from it. Repeats across seeds would settle it.
- **Single participant, in-memory, one laptop.** As with everything else here,
  what transfers is the shape, not the rate.

The shape is what is being claimed: **transfers needing several inputs degrade
geometrically, and the intuitive "k inputs behaves like a pool k times smaller"
understates the damage about twofold.** The level is a good estimate and a
floor, not an identity.

## Practical form

For sizing a pool when transfers gather `k` inputs, the model is implemented in
[`src/contention.ts`](../../../src/contention.ts) and pinned against every run
above by [`test/contention.test.ts`](../../../test/contention.test.ts):

```
predictContention({ ops, pool, inputs })     expected failure rate
poolForTarget({ ops, target, inputs })       pool needed to stay under a target
```

`canton-stress <dar>` uses `poolForTarget` directly to turn a measured
contention rate into "hold N instead of M".

## Reproduce

```powershell
node examples/openzeppelin/gen-multiinput.cjs
powershell examples/openzeppelin/multiinput/results/run-multiinput.ps1
powershell examples/openzeppelin/multiinput/results/run-oos.ps1
```

Raw reports land in `multiinput/results/`.
