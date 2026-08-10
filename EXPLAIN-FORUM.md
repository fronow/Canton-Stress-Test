# Why performance testing a ledger app is harder than it looks

*An explainer for people who build on Canton but don't spend their lives in
performance engineering. No pitch — just the ideas, and why the obvious
approach gives you wrong numbers.*

---

## The question everyone eventually gets asked

> *"Can it handle a thousand transactions a second?"*

It sounds like a question with a number for an answer. It isn't — not until
you've pinned down four things that the question quietly skips over:

- A thousand **offered**, or a thousand **completed**? Those differ, and the gap
  is the whole story.
- A thousand for ten seconds, or for six hours? Systems that pass the first fail
  the second.
- A thousand from one client, or from four hundred? Same rate, different system.
- And when it *can't* — what happens? Does it slow down, or fall over?

Most performance numbers you see quoted answer none of these. That's not
dishonesty; it's that the tooling most people reach for isn't built to.

## Problem 1: the average is a liar

Say you run ten thousand payments and your tool reports *"average latency:
180 ms"*. Sounds healthy.

Now suppose 9,900 of them took 50 ms and 100 of them took 13 seconds. The
average is still fine. But you have a hundred customers watching a spinner, and
if your SLA says "under a second", **you just breached it a hundred times while
your dashboard stayed green.**

This is why serious measurement uses **percentiles**. p99 = "99 out of 100 were
at least this fast". It's the number that describes your unluckiest users
instead of hiding them.

There's a trap here that catches almost everybody. Percentiles are **order
statistics** — they're a position in a sorted list, not a quantity. So you
*cannot average them*. If box A reports p99 = 400 ms and box B reports
p99 = 600 ms, the combined p99 is **not** 500 ms. It could be anything. To
combine them correctly you need the underlying distributions, not the summaries.

Any tool that runs load from several machines and averages their percentiles is
producing a number with no meaning. It will look reasonable. That's the danger.

## Problem 2: coordinated omission — the one that flatters you

This is the subtle one, and it's the reason a lot of published benchmarks are
optimistic by an order of magnitude.

Imagine you're testing a system at 100 requests per second. The natural way to
write the loop is:

```
send a request
wait for the reply
repeat
```

Now the system stalls for 5 seconds.

During that stall, how many requests did your test send? **One** — it was
blocked waiting. So you record *one* 5-second sample.

But in production, you don't have one polite client waiting patiently. You have
real traffic arriving at 100/second regardless. Those 5 seconds should have
produced **500 requests**, and every one of them experienced a wait — the first
one waited 5 seconds, the next 4.99, and so on.

Your test recorded 1 bad sample. Reality had 500. **The test is now
systematically blind to exactly the events you're testing for.** Gil Tene named
this *coordinated omission*: the load generator accidentally coordinates with
the system under test, backing off precisely when things get bad.

The fix is to measure latency from when a request was **due to be sent**, not
from when you actually managed to send it. If the system delays you, that delay
belongs in the number.

It matters because a stall is exactly what you're trying to find. A tool that
looks away during stalls is worse than no tool, because it produces a confident
number.

## Problem 3: on a ledger, "failed" isn't one thing

This is where generic HTTP load tools — k6, JMeter, Gatling — stop being useful.
They can absolutely fire requests at a Ledger API. What they can't do is
understand the answers.

To an HTTP tool, a rejected transaction is a status code. On a ledger, there are
at least three completely different situations wearing the same shirt:

| what happened | what it means | what you do about it |
|---|---|---|
| **Contention** | Two transactions touched the same contract; one lost | Redesign the data model — this is architectural |
| **Rejection** | The transaction was invalid — bad authorization, failed assertion | Fix the code, or fix the test |
| **Slow but fine** | It committed, just late | Capacity problem, not a correctness problem |

Report all three as "errors: 12%" and you've thrown away the only information
that tells you what to do next. Worse, contention is *load-dependent* — it
barely exists at low rates and dominates at high ones. It's the thing you most
need to see, and it's the thing a generic tool is least equipped to show you.

## Problem 4: contention needs a *name*, not a percentage

Knowing "23% contention" tells you that you have a problem. It doesn't tell you
where.

Here's the mental model. Two transactions both want to consume the same
contract. Only one can — the other is told the contract is already gone. On a
ledger this isn't a bug or a race to be fixed with a lock; it's the correctness
guarantee working exactly as designed. But it caps your throughput, and the cap
is set by *which specific contract* everyone is fighting over.

So the useful output isn't a percentage. It's:

> **"87% of your lost races were on this one contract."**

Now you have something to act on: shard it, split it, restructure the choice.

There's a subtlety worth knowing, because it produced a wrong answer in our own
tool before it was fixed. Some contracts appear in *every single transaction* —
a factory or registry that each operation must reference. Naively, those look
like the hottest contracts in the system. But if a contract is only **read**
(non-consuming), it can't conflict with anything. It's in every transaction and
it's contended in none of them.

Attributing blame to it is not a rounding error — it's the wrong answer, and it
sends a team off optimising something that was never the problem. Distinguishing
"touched by everything" from "fought over" is essential, and it's specific to
how ledgers work.

## Problem 5: your test setup can be the bottleneck

The most embarrassing failure mode, and the easiest to fall into.

Suppose you're benchmarking transfers, and you create a pool of 400 coins to
spend. You run a 45-second test at a rising rate. Throughput climbs, then
collapses dramatically at around 30 seconds.

**Have you found the system's breaking point?**

No. You ran out of coins. The test attempted 1,581 transfers against a pool of
400. What you measured was your own setup running dry — but the graph looks
exactly like a system hitting its limit, and the number is quotable, and it's
completely wrong.

We know because we did it. It's written up in the benchmark notes deliberately,
because the shape of that graph is genuinely indistinguishable from a real
cliff unless you know to check.

The discipline: **size your fixtures for the whole run, then verify the
resource that ran out wasn't yours.**

## What honest output looks like

Given all that, a result worth trusting reports:

- **Offered vs. completed** rate — the gap is where the truth lives
- **Percentiles**, never averages; merged from distributions, never averaged
- **Outcomes separated** — committed / contended / rejected, each counted apart
- **Contention attributed** to specific contracts, with read-only ones excluded
- **The failure mode** — did it degrade gracefully or fall off a cliff?
- **What it refuses to conclude.** If a run doesn't show a clean breaking point,
  say so. Nominating the biggest number you happened to see is how noise gets
  published as a finding.

That last one is worth dwelling on. In two of our own ramp runs, differing only
in random seed, one showed a clean throughput cliff and the other was still
climbing when the ramp ended. Same system, same workload, same throughput band —
different verdict. A single 45-second ramp brackets a range; it does not locate
a limit. **The numbers a tool declines to produce are as informative as the ones
it does.**

## A worked example

Running this against a real third-party Token Standard implementation
(OpenZeppelin's Canton token template — their code, not ours) gave a result
that's a fair illustration of why the attribution matters.

The obvious hypothesis was that the shared factory contract would be the
bottleneck. Every transfer goes through it; it's the natural suspect.

It wasn't. The factory is referenced by every transfer but consumed by none, so
it never conflicts. The actual ceiling was **input selection** — two transfers
reaching for the same holding, one finding it already archived. Same headline
number either way; completely different fix. "Make the factory faster" would
have been wasted work.

Worth being precise about what that is and isn't: it's **not a bug**. Their
implementation archives inputs first, on purpose, and comments it as a
contention guarantee. The code is correct. What the measurement adds is the
price of that guarantee under concurrency — which is a design trade-off, and one
you can only see under load.

Along the way it also put a number on something that had no published figure:
reaching a registry's factory requires **explicit disclosure**, and carrying
that ~576-byte blob on every submission costs about 3% throughput while raising
p99 by ~45%. Nearly free at the median, expensive in the tail — which is the
part your SLA is written against.

---

## The short version

Performance testing a ledger app is not "point a load generator at it". The
failure modes are specific: coordinated omission makes stalls invisible,
averaged percentiles are arithmetic that doesn't mean anything, contention needs
a name rather than a rate, and your own fixtures will happily masquerade as the
system's limit.

None of that is exotic. It's just not what general-purpose HTTP tooling was
built for — and on Canton, where throughput assumptions end up written into
contracts, being confidently wrong is expensive.
