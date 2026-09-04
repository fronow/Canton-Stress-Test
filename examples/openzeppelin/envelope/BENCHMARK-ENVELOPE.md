# What a transfer costs: envelope size across two registries

Canton meters traffic (CIP-0104), so every committed transaction is paid for by
the byte. This measures how many bytes two different Token Standard registries
spend to do **the same standard transfer** — and therefore what a data-model
decision costs, per transaction, forever.

Prompted by Kevin at K2F Labs (walley.cc), who pointed out from MainNet data
that *"at these prices, envelope size dominates the economics of a registry long
before latency does"* — median paid traffic ~35.5 KB per transaction, about
**$2.13** at the current $60/MB extra-traffic price.

---

## The measurement, and why it was thought impossible

CIP-0104 traffic cost reads **zero** on a sandbox, because no traffic control is
configured there. This project reported that as `UNMETERED` rather than as a
measured zero, and treated cost as blocked on getting access to a metered
synchronizer.

That framing was too narrow. `POST /v2/interactive-submission/prepare`
interprets a command without submitting it, and returns the **prepared
transaction** alongside the (zeroed) cost estimate. Its size is a real
measurement on any participant, including a sandbox.

So envelope size needs no permission, no metered network and no MainNet access.
Only the *price* is external.

## Result

Same library workload, same single-input standard transfer
(`TransferFactory_Transfer`), same six parties, 20 transfers over a 60-holding
pool. The only thing that differs is the registry.

| registry | prepared transaction | at $60/MB |
|---|---|---|
| std-spike (minimal, ~90 LOC) | **11,733 B** | **$0.6714** per transfer |
| OpenZeppelin `canton-token-template` | **13,955 B** | **$0.7985** per transfer |
| difference | **+2,222 B** | **+$0.127** per transfer, +18.9% |

### This number does not move

Three runs per registry, and the per-operation byte count was **identical every
time** — 11,733 and 13,955 exactly, not approximately.

That is worth stating plainly, because almost nothing else in this project
behaves that way. A latency percentile here is a sample from a noisy
distribution and needs thousands of observations before it means anything.
Envelope size is not a sample at all: it is a property of the transaction's
shape, measured by interpreting the command. One run is enough, and repeated
runs confirm it rather than average it.

## What it means

A wallet author cannot change the protocol overhead. A **registry** author
chooses the data model, and that choice is priced per transaction, on every
transaction, for the life of the registry.

Illustrative arithmetic, with its assumptions stated: at Kevin's observed
network volume of 34K–67K transactions a day, a 2,222-byte difference at $60/MB
works out to roughly **$4,300–$8,500 a day**, or **$1.6M–$3.1M a year**, for
what is otherwise the same standard transfer.

Treat that as a sense of scale, not a bill. It assumes that volume flows through
one registry, assumes the $60/MB price holds, and uses a lower bound for the
bytes (below). But the direction is not in doubt: **envelope size is a
first-order economic decision and it is currently invisible at design time.**

## The gap is the settlement model, not the data model

The 2,222 bytes above look like a data-model difference. They are not.

The two registries are not doing the same work. std-spike completes the transfer
in one transaction: archive the inputs, create the receiver's holding and the
change. OpenZeppelin, absent a `TransferPreapproval` in the context, takes its
`twoStepTransfer` path — creating a `SimpleTransferInstruction` and a
`LockedSimpleHolding` for the receiver to accept later. So the comparison was a
**completed transfer against half of a two-step one**.

Isolating each registry's direct-completion path (via self-transfer, which both
complete immediately) separates the two effects:

| registry | path | envelope | at $60/MB |
|---|---|---|---|
| std-spike | cross-party | 11,733 B | $0.6714 |
| std-spike | direct | 11,733 B | $0.6714 |
| OpenZeppelin | two-step | 13,955 B | $0.7985 |
| OpenZeppelin | **direct** | **11,446 B** | **$0.6549** |

std-spike is byte-identical on both paths, because it always completes — which
is a useful control: it shows the difference is not an artifact of self-transfer.

**On the direct path OpenZeppelin is 287 bytes *cheaper* than the minimal
registry.** Its richer data model — `instrumentId`, `meta`, five fields against
three — costs it nothing measurable. The entire 2,222-byte gap, and 287 bytes
beyond it, is the settlement model:

```
propose/accept vs direct completion:  +2,509 B  =  +$0.1436 per transfer
data model, one registry vs another:    −287 B  =  −$0.0164 per transfer
```

**And this understates propose/accept**, because a two-step transfer is not
finished. The receiver still has to accept, which is a second transaction with
its own envelope. $0.14 is the floor on what the pattern costs, not the total.

The design rule that falls out: **choosing propose/accept over direct completion
is the expensive decision, and it is an order of magnitude more expensive than
the data model choices that usually get argued about.** For registries that can
support preapprovals, the direct path is worth real money.

### The proxy was not equivalent — measured 2026-09-05

The direct path above was reached by self-transfer, because a preapproved
cross-party transfer needs a `TransferPreapproval` in `extraArgs.context` and
that had not been built. **It has now been built and run, and the proxy was
materially different:**

| path | envelope | at $60/MB |
|---|---|---|
| self-transfer *(the proxy)* | 11,446 B | $0.6549 |
| two-step (propose/accept) | 13,955 B | $0.7985 |
| **preapproved cross-party direct** | **15,689 B** | **$0.8977** |

A real preapproved transfer is **4,243 bytes heavier than the proxy**, for two
reasons that cannot be separated by this measurement alone: it discloses a
second contract (the preapproval, whose signatories are the admin and the
receiver, so the sender cannot see it otherwise), and it runs a different code
path from the self-transfer merge.

**So on a single-transaction basis the direct path is more expensive than
two-step** — the opposite of what the proxy suggested. But a two-step transfer
is not finished when its first transaction commits, so the honest comparison is
per *completed* transfer, and that needed the acceptance measuring too.

### Settled: measure both transactions

`attrib-oz-accept.json` runs the second half — the receiver exercising the
standard `TransferInstruction_Accept` on instructions produced in setup. 16 of
16 committed, no contention.

| | envelope | at $60/MB |
|---|---|---|
| two-step, 1: `TransferFactory_Transfer` | 13,955 B | $0.7985 |
| two-step, 2: `TransferInstruction_Accept` | 12,265 B | $0.7018 |
| **two-step, completed transfer** | **26,220 B** | **$1.5003** |
| **direct (preapproved), completed transfer** | **15,689 B** | **$0.8977** |

**Propose/accept costs +10,531 bytes, or +$0.60 per completed transfer — 67%
more than settling directly.**

That is over four times the +2,509 B this document previously reported, and the
earlier figure was wrong twice over: it counted only the first of the two
transactions, and it used a proxy that understated the direct path. Both halves
are now measured end to end.

**One amortisation note that matters.** The direct path requires a
`TransferPreapproval` to exist, and creating it is itself a transaction. But a
preapproval is created once per receiver and reused for every subsequent
transfer to them, whereas an acceptance is paid on every single transfer. So the
gap above is the steady-state figure, and it widens rather than narrows with
volume — the preapproval's cost is divided by the number of transfers it serves.

### What this replaces

The design rule stands and is now larger than first stated: **the settlement
model is the expensive decision.** At 26,220 against 15,689 bytes, choosing
propose/accept over preapproved direct settlement costs about 67% more per
completed transfer — against a data-model difference between the two registries
of 287 bytes, under 2%.

## What drives it: stakeholder count, linearly

The obvious follow-up is *why* — and the first candidate was informee count,
since a confirmation request carries encrypted views per informee.

`StdTransferFactory` has `users : [Party]` as its observer list, so creating one
with N users gives a transaction with N+1 informees and an otherwise **identical
payload**. Nothing else varies.

| observers | informees | prepared bytes | at $60/MB |
|---|---|---|---|
| 1 | 2 | 1,056 | $0.0604 |
| 2 | 3 | 1,233 | $0.0706 |
| 4 | 5 | 1,581 | $0.0905 |
| 8 | 9 | 2,277 | $0.1303 |
| 16 | 17 | 3,681 | $0.2106 |
| 32 | 33 | 6,497 | $0.3718 |

It is linear, and unusually cleanly so:

```
bytes = 878 + 175.5 × observers
```

Residuals across the whole 32-fold range: **+2, +4, +1, −5, −5, +3 bytes.** The
increment measured between each adjacent pair is 177, 174, 174, 175.5, 176
B/observer — the same number every time.

**At $60/MB, 175.5 bytes is $0.0100. Each additional stakeholder costs almost
exactly one cent per transaction.**

That is a design rule an author can act on. Adding one observer to a contract
that sees 50,000 transactions a day costs roughly **$500 a day, $180K a year**,
for that one decision — and it is invisible at design time today.

### The slope is NOT a constant — it depends on the transaction

The figure above was measured on a *create* of a small factory. Repeating the
experiment on the **transfer** path — varying the factory's `users` list, whose
members are stakeholders of the contract the transfer exercises, so they are
informees of the transfer — gives a very different rate:

| stakeholders | create | transfer |
|---|---|---|
| 2 | 1,233 B | 9,997 B |
| 4 | 1,581 B | 10,865 B |
| 8 | 2,277 B | 12,601 B |
| 16 | 3,681 B | 16,103 B |
| 32 | 6,497 B | 23,127 B |

```
create:    878 + 175.5 × N     residuals ±5 B
transfer:  9,110 + 437.8 × N   residuals ±12 B
```

Both linear, both to within a handful of bytes over a sixteen-fold range — but
**a stakeholder costs 2.5× more on a transfer than on a create**: $0.0251
against $0.0100 at $60/MB.

This matters more than it looks. The create-only figure was very nearly
published as "about a cent per stakeholder", which would have been wrong by 150%
for the transaction the audience cares about. **There is no single
cost-per-stakeholder constant to quote.** Linearity is the robust finding; the
coefficient has to be measured per operation, which is the argument for having a
tool do it rather than estimating.

**Cross-check.** The transfer fit predicts 11,737 B at six parties. The
independent std-spike transfer measured at the top of this document is
**11,733 B** — four bytes out, from a fit built on entirely separate runs.

### "Informee count dominates" needs qualifying

The hypothesis as originally put — that informee count is *the dominant term* —
is confirmed as a mechanism and wrong as a generalisation. On the transfer path
the fixed part is 9,110 bytes, so:

- at 6 parties, stakeholders are about **22%** of the envelope,
- at 32 parties, about **61%**.

So it depends entirely on how many stakeholders a design has: it only becomes
the dominant term past roughly twenty parties. And what makes the two registries
differ by 2,222 bytes is therefore **not** stakeholder count — both had the same
six-party population. That difference is still unattributed.

## Honest limits

- **This is a lower bound, not the traffic bill.** The prepared transaction is
  not the sequenced confirmation request, which additionally carries encrypted
  views per informee. The metered figure will be larger. Ours are 2.6–3.1×
  below Kevin's 35.5 KB MainNet median, which is the right direction and a
  plausible multiplier — but that is consistency, not confirmation.
- **The direct path was reached by self-transfer**, not by a preapproved
  cross-party transfer. Both complete in one transaction, but they are not the
  identical operation, and building a `TransferPreapproval` into the context
  would make the attribution exact rather than close.
- **Only two registries.** "Settlement model dominates data model" is measured
  on one pair. It is a strong effect (2,509 B against 287 B) and the mechanism
  is clear from the code, but a third implementation would test whether the
  ratio generalises.
- **$60/MB is quoted, not measured.** It is the price Kevin cites for MainNet
  extra traffic. The tool never assumes a price: `--traffic-price` is opt-in,
  and the price used is recorded beside the figure it produced.
- **Single participant, in-memory, one laptop** — though unlike throughput and
  latency, that matters far less here, because the transaction's size is not a
  property of the machine interpreting it.

## Reproduce

```powershell
node src/cli.ts <registry.dar> --java-home <jdk> --traffic-price 60
```

Any DAR implementing the Token Standard works with no configuration; the tool
reads the registry out of the DAR itself. The full comparison:

```powershell
powershell examples/openzeppelin/envelope/run-envelope.ps1
```

Raw reports in `envelope/*.json`.

### A gotcha worth knowing

The `prepare` call must be given the same `disclosedContracts` as the real
submission. A registry factory is typically `signatory admin` with no observers,
so without disclosure the call fails `CONTRACT_NOT_FOUND`, is swallowed, and the
run reports **no traffic section at all** — silently. std-spike happens to work
without it because its factory carries `observer users`; OpenZeppelin's does
not. Testing against one registry would have shipped this broken.
