# Multi-input contention — pre-registered predictions

Written **before** the confirming runs, so the ordering is provable in git
history. Do not edit the numbers below after a run; add results underneath.

## Round 1 (already run) — the linear guess, and how it failed

`gen-multiinput.cjs` predicted, before the runs, that contention would rise
*linearly* with the number of inputs `k`: a k-input transfer out of a pool of
1200 would behave like a single-input transfer out of 1200/k.

| k | predicted | measured |
|---|---|---|
| 1 | 5.0% | 3.3% |
| 2 | 10.0% | 15.8% |
| 4 | 20.0% | 38.3% |
| 8 | 40.0% | 63.3% |

**The prediction was wrong from k=2 up, and wrong in a consistent direction:**
it under-predicts, by roughly 2x at k=4 and k=8. Gathering k inputs is
substantially worse than shrinking the pool by k.

## The revised model (POST-HOC — fitted to the data above, not predicted)

A transfer fails if **any one** of its `k` inputs has already been spent. So the
survival probability is not `1 - k·p`, it is `(1 - p)^k`. Failures consume
nothing, so the pool is drawn down only by *committed* transfers:

```
p  = f / 2            probability one input is already spent
f  = k · ops · c / pool    fraction of the pool actually consumed
c  = (1 - p)^k        the share of transfers that commit
```

Solving the fixed point `c = (1 - c·k·ops/(2·pool))^k` needs only `k`, `ops`
and `pool`. At `k = 1` it reduces to `f/2` — the original turnover law — so
this is a generalisation of it, not a replacement.

Refitted against round 1: 4.8 / 16.1 / 40.0 / 67.3% vs measured
3.3 / 15.8 / 38.3 / 63.3%. Mean absolute error ~2.1 points across a range
from 3% to 63%. It over-predicts slightly at every point.

**This is a curve fitted to four points. It is not yet evidence.**

## Round 2 (NOT yet run) — the out-of-sample test

Three points the model has never seen. Two interpolate `k`; the third moves
the pool instead, so `k` and `f` are varied independently rather than
together.

| run | k | ops | pool | PREDICTED contention |
|---|---|---|---|---|
| `oos-k3`        | 3 | 120 | 1200 | **28.8%** |
| `oos-k6`        | 6 | 120 | 1200 | **56.6%** |
| `oos-k4-pool2x` | 4 | 120 | 2400 | **26.3%** |

For contrast, the discredited linear model predicts 15% / 30% / 10% for these
three. The two models are far enough apart at every point that one run
distinguishes them.

Standing rule from the turnover work: the model is an estimate and a floor,
not an identity. It is expected to under-predict where genuine concurrent
collisions add on top of the bookkeeping effect. Judge it on whether it lands
within a couple of points and tracks the shape, not on exactness.

## Round 2 results

| run | k | pool | linear | geometric (predicted) | **measured** | geo. error |
|---|---|---|---|---|---|---|
| `oos-k3`        | 3 | 1200 | 15% | 28.8% | **21.7%** | −7.1 |
| `oos-k6`        | 6 | 1200 | 30% | 56.6% | **62.5%** | +5.9 |
| `oos-k4-pool2x` | 4 | 2400 | 10% | 26.3% | **23.3%** | −3.0 |

Mean absolute error: **geometric 5.3 points, linear 17.5 points.** The
geometric form is closer at all three points, and the gap is widest exactly
where the two models disagree most (`oos-k6`: 62.5% measured against the
linear model's 30%).

`oos-k4-pool2x` is the one that matters most. It holds `k` fixed and doubles
the pool, so it tests the model where `k` and `f` are varied *independently*
rather than together as they are in round 1. Predicted 26.3%, measured 23.3%.
The fit is not an artifact of `k` and `f` moving in lockstep.

**What this does and does not establish.** The shape is confirmed: transfers
needing several inputs degrade *geometrically*, because the transfer fails if
any one input is stale. The linear intuition — "k inputs behaves like a pool
k times smaller" — is refuted, and it is wrong in the dangerous direction: it
under-states the damage roughly twofold.

The residual is ±7 points, against ±2 for the fitted round-1 curve. That is
what fitting flatters, and the honest number for prediction is the ±7. Each
point here is a single run, and the turnover work already established that
these runs are seed-sensitive; ±7 is consistent with that noise, but three
runs cannot separate model error from seed noise. Repeats across seeds are
what would settle it, and until then this is a good estimator of the shape
and a rough one of the level.
