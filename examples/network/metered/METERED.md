# Billed traffic on a metered network

Every cost figure canton-stress published before this came from a sandbox with
no traffic control, so the only size it could report was the prepared
transaction, which was described as a lower bound on the bill. It is not: for
token transfers it turned out to be about 3x the bill (see the reference table
below). This directory measures what a synchronizer actually **bills**, by
turning traffic control on in the two-participant network and reading each
node's consumed traffic from the sequencer.

Measured 2026-10-10, Canton 3.4.11 (the distribution bundled with the Daml SDK),
two participants + sequencer + mediator, all in memory on one machine.

## How Canton bills traffic

From `EventCostCalculator` in Canton 3.4.11, for each message a node sends
through the sequencer:

    cost = size + size × recipients × readVsWriteScalingFactor / 10,000

The **submitting** participant pays for the confirmation request. Each
**confirming** participant pays for its own confirmation response (unless the
synchronizer sets `free_confirmation_responses`). The **mediator** pays for its
verdicts.

## Result: one cross-participant accept

The workload is `../workload-cross-participant.json`: an issuer on participant 1
creates `PaymentOffer`s, and the counterparty on participant 2 accepts them.
Bytes billed per committed accept, from the difference between runs:

| Who pays | Session 1, run 2 (20) | Session 1, run 4 (20) | Clean restart (20) |
|---|---|---|---|
| participant 2, **submitter** | 3,664 | 3,663 | 3,649 |
| participant 1, **confirmer** | 356 | 355 | 348 |
| mediator | 151 | 151 | 151 |
| canton-stress **estimate** (submitter) | — (failed, see below) | 3,676 | 3,681 |
| prepared-transaction size | — | 3,424 | 3,424 |

A third run in session 1 (60 offered, 50 committed) gave 3,655 / 345 / 151.

What this shows:

1. **The estimate matches the bill.** The CIP-0104 estimate that canton-stress
   reads from `interactive-submission/prepare` came within 1% of what the
   submitter was actually charged for this transaction (3,676 vs 3,663; 3,681
   vs 3,649), and within 4% across all eight cases in the reference table
   below. On a metered synchronizer the tool's cost figure can be trusted for
   the submitter's share.
2. **The submitter is not the only one who pays.** The confirming
   counterparty paid 348–356 B per accept, and the estimate does not include
   that. A transaction's cost is spread over every participant that confirms
   it.
3. **The prepared transaction is NOT a reliable proxy for the bill.** For this
   small settlement accept it came out 6–7% under the submitter's bill. For
   Token Standard transfers (next section) it came out about **3× over**. The
   prepared transaction carries full copies of input and disclosed contracts,
   uncompressed; the sequencer bills compressed, encrypted views. Use the
   CIP-0104 estimate or the measured bill, not the prepared size.
4. **Creates.** Each `PaymentOffer` create cost its submitter about 3,470 B,
   with 151 B to the mediator, and almost nothing to participant 2, which hosts
   only an observer and confirms nothing.

## Reference table: Token Standard transfers, billed

Same metered network, `measure-table.cjs`, 10 operations per case at
concurrency 1. Bytes billed per committed transaction. "Typical" is the draft
Universal Burn CIP's reference transaction, 16,667 B ($1 at $60/MB). Raw rows in
`results/table-*.row.json`, combined in `results/workload-costs.json`
(`build-table.cjs` regenerates both).

| Case | Billed to participants | Mediator | Estimate (vs bill) | Prepared | Billed ÷ prepared | × typical | $ at list |
|---|---|---|---|---|---|---|---|
| OpenZeppelin two-step transfer, step 1 (propose) | 4,317 | 151 | 4,279 (−0.9%) | 13,950 | 0.31 | 0.26 | $0.259 |
| OpenZeppelin two-step transfer, step 2 (accept) | 4,237 | 151 | 4,087 (−3.5%) | 12,260 | 0.35 | 0.25 | $0.254 |
| OpenZeppelin preapproved direct transfer | 4,448 | 151 | 4,309 (−3.1%) | 15,684 | 0.28 | 0.27 | $0.267 |
| std-spike direct transfer, 6 parties | 4,125 | 151 | 4,061 (−1.6%) | 11,728 | 0.35 | 0.25 | $0.247 |
| std-spike transfer, 2 stakeholders over two participants | 4,011 | 151 | 3,980 (−0.8%) | 9,992 | 0.40 | 0.24 | $0.241 |
| std-spike transfer, 4 stakeholders over two participants | 4,147 | 151 | 4,098 (−1.2%) | 10,860 | 0.38 | 0.25 | $0.249 |
| std-spike transfer, 8 stakeholders over two participants | 4,116 | 151 | 4,134 (+0.4%) | 12,596 | 0.33 | 0.25 | $0.247 |
| std-spike transfer, 16 stakeholders over two participants | 4,201 | 151 | 4,201 (0.0%) | 16,098 | 0.26 | 0.25 | $0.252 |

What it says:

- **A completed propose/accept transfer is billed 8,554 B against 4,448 B for
  a preapproved one: +92%.** On prepared size the same comparison said +67%.
  The settlement-model finding survives the switch to billed bytes and gets
  stronger.
- **The estimate is within 4% of the bill in every case**, slightly under in
  most. On a metered synchronizer, `--traffic-price` should be fed from the
  estimate, not from the prepared size.
- **Stakeholders on participants that already take part cost almost nothing.**
  2 → 16 stakeholders over the same two participants added ~190 B in total
  (~14 B each), against ~437 B each on prepared size. Participant 2 hosted
  half of them and paid nothing: observers do not confirm. The sequencer
  delivers per participant, not per party. *Superseded by the participant
  series below:* in this sweep every committed transfer had its receiver on
  the submitter's node (a bug in how `$p1` was resolved, see below), so it
  measured observers only. With the receiver on another node the picture
  changes: what matters is each participant's ROLE.
- **These are far below "typical".** A local transfer is about 0.25 of the
  CIP's reference transaction. MainNet transactions observed by an operator ran
  around 35.5 KB median, which fits transfers that involve many more
  participants (and more confirmers) than a two-node test network.

In the sweep only 5 of 10 transfers committed. That was not contention: it was
a canton-stress bug, found and fixed while running the participant series
below. Failed transfers are refused on the submitting participant before
sequencing and are not billed, so the per-transfer bills above stand, but they
describe a transfer whose receiver sits on the sender's node.

## Participant series: what each participant's role costs

Measured 2026-10-11 on `../four-participants.conf` (four participants, same
metered settings), std-spike transfer, 8 parties placed round-robin, 120
holdings, 10 transfers per case, all 10 committed in every case. Bytes billed
per transfer. Cases `obs-*` and `conf-*` in `measure-table.cjs`.

| Case | Submitter billed | Estimate | What the other nodes paid |
|---|---|---|---|
| all 8 parties on 1 participant | 4,033 | 4,085 | — |
| receiver (and some observers) on a 2nd participant | 6,133 | 5,991 | 0 |
| + observers on a 3rd participant | 6,252 | 6,047 | 0 |
| + observers on a 4th participant | 6,308 | 6,090 | 0 |
| admin (a signatory) on a 2nd participant, parties over 2 | 4,317 | 4,355 | admin's node 441 |
| admin on a 2nd participant, parties over 4 | 4,501 | 4,441 | admin's node 437 |

(Nodes with no role show ±97 B per transfer: Canton's background traffic,
spread over 10 transfers.)

What it says:

- **The receiver's participant is the expensive one.** Putting the receiver on
  another node added about 1.9–2.1 KB to the submitter's bill, roughly +47%.
- **Observer-only participants are cheap.** Each one added about 50 B to the
  submitter's bill and paid nothing itself.
- **A confirming participant pays its own way.** With the registry admin on
  another node, that node paid ~440 B per transfer for its confirmation, and
  the submitter's bill rose ~300 B.
- **The estimate held** within 4% of the submitter's bill in every case.

So "the bill follows the participants" is too coarse. It follows what each
participant has to receive or confirm. That is the kind of rule a design-time
cost model needs, and the next thing to establish is why the receiver's node
costs so much more than an observer's.

The bug: operations rotate across participants, and each participant resolved
`$p0`/`$p1` against its own local parties, so on node 2 "`$p0`" was a
different party. On a 4-node run 3 of every 4 transfers failed as
CONTRACT_NOT_FOUND and were reported as contention. Positional references now
resolve to the same party on every node (test: "positional parties" in
`test/placement.test.ts`).

## Two things found on the way

- **With rate limiting off, nothing is recorded.** The first attempt enabled
  traffic control with `enforceRateLimiting = false` so nobody would need to
  buy traffic. 150 committed creates later, every counter was still zero. The
  bootstrap now gives each node a large balance and switches enforcement on,
  which is also what production looks like.
- **canton-stress estimated cost on the wrong participant.** Every estimate
  went to the first participant, which refuses to prepare for a party it does
  not host (`ParticipantAuthorizationError`). On any multi-participant run
  there was never a cost figure, and the failure was silent. Both are fixed:
  estimates go to the submitter's participant, and a failed estimate is now
  printed with its reason. Runs 2 and 3 above predate the fix, which is why
  their estimate column is empty.

## Reproduce

```bash
# 1. Boot the metered network (one command; wait for "STRESSNET READY (METERED)")
cd examples/network
java -jar "$APPDATA/daml/sdk/3.4.11/canton/canton.jar" daemon \
  -c two-participants.conf --bootstrap bootstrap-metered.canton --no-tty

# 2. Upload the settlement DAR to both participants (see ../README.md)

# 3. Baseline, setup only, then measured accepts
bash metered/read.sh start
bash metered/step.sh setup --setup-only
bash metered/step.sh accepts-20 --ops 20 --warmup 0
```

`read.sh` asks the sequencer. A participant can also read its own bill from its
own admin API, which is what an operator could do on a real network:
`canton run traffic-state.canton -c remote.conf` (in `examples/network/`).
Both views agreed to the byte here (1,050,836 and 77,610).

Billed bytes per accept = (consumed after `accepts-20` − consumed after
`setup`) minus one setup's cost, divided by committed accepts. Every run
repeats the same 150-offer setup, so its cost is measured once by the
setup-only step and subtracted.

## Limits

- **`readVsWriteScalingFactor = 4` is assumed** to match the Global
  Synchronizer. At this value the recipients term adds well under 1% for two
  recipients, but confirm it against MainNet's published synchronizer
  parameters before quoting absolute numbers.
- **Up to four participants, one transaction family.** The participant series
  covers 1–4 nodes and one signatory; transactions with several confirming
  signatories, or many more nodes (MainNet), are not measured here.
- **Background traffic exists.** Between runs each participant gained a few
  hundred bytes with no transactions running. Small against these deltas, but
  measure over enough transactions that it stays negligible.
- **Uploading a DAR is billed** once enforcement is on (2,531 B per
  participant here). The baseline reading absorbs it.
- In memory, one machine. Byte counts do not depend on the machine; timings
  would, and none are claimed here.
