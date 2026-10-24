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

## Summary of findings

1. **Canton's own cost estimate matches the bill.** The CIP-0104 estimate from
   `interactive-submission/prepare` came within about 4% of what the sequencer
   billed the submitter in every case measured (worst 4.3%), and tends to read
   slightly low. See the [reference table](#reference-table-token-standard-transfers-billed).
2. **The prepared-transaction size is not the bill.** It overstated the billed
   bytes 2.5x to 4.75x for token transfers.
3. **The settlement model is the expensive design choice.** A completed
   propose/accept transfer is billed 92% more than a preapproved one.
4. **What a participant costs depends on its role.** A node hosting only the
   receiver adds a fixed ~1.9-2.3 KB; an observer-only node ~50 B; a node
   hosting a confirming signatory adds ~212 B to the submitter and pays ~300 B
   itself. See the [participant series](#participant-series-what-each-participants-role-costs)
   and the [cost model](#a-first-cost-model-tested-by-predicting-before-measuring).
5. **Data is billed once, after compression**, not once per node.
6. **A Canton Coin transfer at MainNet's size bills the sender ~8.4 KB.**
   Shaped like MainNet's most common transaction (through the receiver's
   preapproval, with a featured-app marker and the event log; same package as
   MainNet) and with the DSO on 13 hosts, MainNet's Super Validator count: the
   sender was billed **8,357 B (~$0.50 at $60/MB)** and all nodes together
   15,675 B, both predicted in advance. The same payment as an offer plus an
   accept costs the users 14,963 B and the network 25,501 B: **the preapproval
   saves 44%**. See [13 hosts](#a-completed-transfer-mainnets-shape-on-13-hosts).
   Each extra DSO host adds ~230 B, in a straight line from 1 to 43 hosts
   (measured on the offer; Canton's estimate stayed within 1% of the line
   published from eight nodes). Above ~24 hosts
   every DSO host was also billed about 1 KB per transfer more than the
   transaction accounts for; the cause is not yet identified. See
   [DSO hosting](#amulet-with-the-dso-hosted-on-several-participants).
7. **The submitter pays per confirming participant, not per confirming
   party.** Two co-signers sharing one node cost the submitter the same as
   one; the node itself pays ~160 B more per extra party it confirms for. See
   [confirming parties or participants](#confirming-parties-or-confirming-participants).
8. **Each extra input holding adds ~120 B**, linearly from 1 to 8 inputs. With
   production's typical 1-3 inputs, inputs are a minor cost. See
   [inputs per transfer](#inputs-per-transfer).
9. **A first cost model predicts unmeasured cases.** 25 predictions of the
   submitter's bill were written down before measuring; 23 landed within 5%.
   The predictions made for Canton's own estimate all landed within 2%. See
   [PREDICTIONS.md](PREDICTIONS.md).

> **Correction (2026-10-21).** Every Amulet figure in this directory before
> rounds 7 and 8 measured the **offer**, the first step of a two-step transfer,
> not a completed transfer: with no preapproval in its context,
> `TransferFactory_Transfer` locks the sender's amulet and creates an
> `AmuletTransferInstruction` for the receiver to accept (checked on the ledger:
> three runs left three locked amulets and three pending instructions). Those
> numbers are correct as the cost of an offer and are labelled so below.

## Contents

- [How Canton bills traffic](#how-canton-bills-traffic)
- [Result: one cross-participant accept](#result-one-cross-participant-accept)
- [Reference table: Token Standard transfers, billed](#reference-table-token-standard-transfers-billed)
- [Participant series: what each participant's role costs](#participant-series-what-each-participants-role-costs)
- [Canton Coin (Amulet)](#canton-coin-amulet)
- [Amulet with the DSO hosted on several participants](#amulet-with-the-dso-hosted-on-several-participants)
- [A completed transfer, MainNet's shape, on 13 hosts](#a-completed-transfer-mainnets-shape-on-13-hosts)
- [A first cost model, tested by predicting before measuring](#a-first-cost-model-tested-by-predicting-before-measuring)
- [Inputs per transfer](#inputs-per-transfer)
- [Confirming parties or confirming participants?](#confirming-parties-or-confirming-participants)
- [Things found on the way](#things-found-on-the-way)
- [Reproduce every result](#reproduce-every-result)
- [Files](#files)
- [Large networks (43 participants)](#large-networks-43-participants)
- [Limits](#limits)

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
concurrency 1. Bytes billed per committed transaction. "Typical" is the
reference transaction behind CIP-0129's "about $1 for a typical transaction" at
$60/MB: 16,667 B. Raw rows in
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

## Canton Coin (Amulet)

The first Amulet transfer **offer** run end to end on the metered network (the
first step of a two-step transfer; see the correction above), through the
same standard `TransferFactory_Transfer` (workload generated by
`amulet/gen-amulet.cjs`; splice-amulet 0.1.23). An Amulet transfer reads one
entry from its choice context, the DSO's `ExternalPartyConfigState`, which the
workload creates in setup, discloses to the sender and passes in. Holding
fees are zeroed so nothing expires mid-run. 10 of 10 committed in both cases.

| Case | Submitter billed | Estimate | Prepared |
|---|---|---|---|
| Amulet transfer offer, 1 participant | 4,693 | 4,535 (−3.4%) | 22,307 |
| Amulet transfer offer, receiver on a 2nd participant | 6,986 | 6,688 (−4.3%) | 22,307 |

- **Same rule as the token transfers:** a receiver on another node adds about
  2.3 KB (+49%).
- **The prepared size is 4.75x the bill** here, the largest gap measured.
- **The estimate is 4.3% under the bill** in the second case, the widest miss
  so far. Across all cases measured, the estimate is within about 4%, worst
  case 4.3%, and it tends to read low.
- **Not yet like MainNet.** Here the DSO is one party on one node. On MainNet
  it is hosted by every Super Validator node, so an Amulet transfer has many
  more confirming participants. Given what a confirming node costs (above),
  that is the most likely reason MainNet transactions are several times larger
  than these, and the next thing to measure.

## Amulet with the DSO hosted on several participants

On MainNet the DSO is hosted by every Super Validator node, so an Amulet
transfer is confirmed by many participants. Here a DSO party is created hosted
on the first K participants of the network (`multihost-dso.canton.tmpl`,
driven by `run-dso-series.sh`), and the same Amulet transfer offer is measured
with it (`--role-party admin=<dso>`).

Measured 2026-10-12 on an eight-participant network (`participants-8.conf`
from `../gen-network.cjs`), 10 transfers per case, all committed. Hosts 6 and
7 were re-measured with 30 transfers because the 10-transfer runs were visibly
noisy (see [PREDICTIONS.md](PREDICTIONS.md), round 3); the table shows the
30-transfer values for those two.

| DSO hosted on | Submitter billed | Extra hosts paid (each) | All participants | Estimate |
|---|---|---|---|---|
| 1 | 4,601 | — | 4,601 | 4,549 |
| 2 | 4,819 | 370 | 5,189 | 4,770 |
| 3 | 5,077 | 338, 338 | 5,753 | 5,003 |
| 4 | 5,330 | 402, 402, 338 | 6,472 | 5,220 |
| 5 | 5,603 | 338, 338, 435, 338 | 7,052 | 5,443 |
| 6 | 5,813 | 338, 338, 518, 428, 428 | 7,863 | 5,671 |
| 7 | 6,038 | 428, 338, 338, 248, 338, 428 | 8,156 | 5,895 |
| 8 | 6,175 | 531, 338, 338, 338, 531, 531, 338 | 9,120 | 6,123 |

(Mediator 151 B throughout. Per-host payments scatter between ~250 and ~530 B:
background traffic between nodes grows with the size of the network. The raw
files for hosts 1 and 4 were accidentally overwritten by a later smoke test and
re-measured on the same eight-node network: 4,601 B (identical) and 5,283 B /
6,297 B (against 5,330 / 6,472 above); see PREDICTIONS.md, round 3. An earlier
session on the four-participant network gave 4,601 / 4,823 / 5,076 / 5,272 B
for hosts 1-4.)

Straight-line fits in the number of extra hosts:

| Measure | Per extra host | R² | Largest residual | At 43 hosts (extrapolated) |
|---|---|---|---|---|
| Submitter's bill | 233.3 B | 0.995 | 73 B | 14,413 B |
| All participants | 635.5 B | 0.995 | 208 B | 31,241 B |
| CIP-0104 estimate | 224.6 B | 1.0000 | 6 B | 13,983 B |

- **Each extra confirming host adds ~233 B to the submitter's bill and ~636 B
  across the network**, the difference being what the host pays for its own
  confirmation. Linear over all eight points.
- **The estimate is a perfect line** (within 6 B of it at every point), so the
  per-host increment is a property of the transaction, not noise. It tracks
  the submitter's bill within about 2-4% and, by construction, cannot see what
  the other hosts pay.
- **These points were predicted.** Hosts 5-8 were predicted from hosts 1-4
  before the eight-node network was booted; the submitter's bill landed within
  5% in all four (PREDICTIONS.md, round 3).
- **Extrapolation at the time of the eight-node run, now measured (below):** carried to 43
  hosts (then wrongly believed to be MainNet's Super Validator count; it is 13), the line gives ~14 KB for the submitter and ~31 KB across the
  network. That is the same order as the 16.7 KB typical transaction in the Universal Burn deck, an
  operator's 35.5 KB node median, and a public average of roughly 23 KB
  (September 2026 traffic purchased over transactions). The 43-host figure
  barely moved when the evidence doubled from four points to eight (14.1 to
  14.4 KB), but it is still eight points carried to 43.

Two differences from MainNet, both deliberate: the DSO here has threshold 1,
because Canton refuses to submit for a party with a higher threshold (a
"consortium party") from a single participant and this workload's setup has
to submit as the DSO; the extra hosts still receive the request and confirm,
which is what is being measured. And MainNet transfers carry more than this one
(featured-app markers, several inputs, reward accounting).

### Measured up to 43 hosts

> **Correction (2026-10-20).** Earlier versions of these notes called 43
> "MainNet's Super Validator count". It is not: MainNet's DSO rules list **13**
> Super Validator nodes (public Scan API, `/v0/dso`, read 2026-10-20). The
> measurements stand as measurements of 1-43 hosts; at 13 hosts the measured
> line gives about **7.3 KB** for the submitter (7,310 B, interpolated between
> the 8- and 16-host points; estimate 7,254 B).
>
> A sample of 200 MainNet transactions (one minute, 2026-10-20, Scan
> `/v2/updates`) shows the single `TransferFactory_Transfer` measured here is
> the most common MainNet transaction (35%), but real ones route through the
> receiver's transfer preapproval and add a featured-app marker and two
> holdings-change log events (median 8 events per transaction), which this
> workload does not.

Run on a rented 8-vCPU, 64 GB machine with `cloud/run-scale.sh` (N=43, 30
transfers per case, 25 committed each), against predictions published before
the run ([PREDICTIONS.md](PREDICTIONS.md), round 6).

| DSO hosts | Submitter billed | Estimate | Submitter − estimate | Each other host paid |
|---|---|---|---|---|
| 1 | 4,598 | 4,549 | 49 | — |
| 8 | 6,174 | 6,123 | 51 | 338 |
| 16 | 7,992 | 7,932 | 60 | 339-429 |
| 24 | 9,806 | 9,755 | 51 | 146 or 340 |
| 32 | 12,449 | 11,582 | 867 | 1,143-1,544 |
| 43 | 15,119 | 14,115 | 1,004 | 481-1,285 |
| 43 (repeat) | 15,126 | 14,127 | 999 | 340-1,285 |

- **The transaction scales linearly to 43 hosts.** The estimate (the
  transaction's own size) landed within 1% of the published prediction at every
  point; ~227 B per extra host against 224.6 B from the eight-node fit.
- **The submitter's bill: 5 of 6 predictions within 5%** (32 hosts +5.1%,
  43 hosts +4.9%), and the repeat at 43 hosts came within 7 B of the first.
- **An extra ~1 KB per DSO host appears above ~24 hosts.** Up to 24 hosts the
  submitter is billed a constant ~50 B over the estimate; at 32 and 43 it is
  ~870-1,000 B over, and the other hosts jump from ~340 B to ~1,100-1,550 B.
  Ten quiet minutes afterwards billed every node 0 B, so it is not traffic on a
  timer. Candidates, untested: exchanges between nodes sharing contracts that
  only advance while transactions flow, or side effects of an overloaded
  machine (CPU-starvation warnings in the log). It makes the network-wide
  totals at 32-43 hosts roughly double the line's prediction.
- **32 hosts needed longer confirmation deadlines.** On 8 vCPUs, confirmations
  from 32 hosts missed Canton's default 30 s deadline; raising it to 120 s
  (`cloud/raise-timeouts.canton`) let the case run. It changes how long Canton
  waits, not what it bills.

## A completed transfer, MainNet's shape, on 13 hosts

MainNet's DSO has 13 Super Validator nodes, and its most common transaction
(35% of 200 sampled on 2026-10-20) is a `TransferFactory_Transfer` that
completes through the receiver's `TransferPreapproval`.
`amulet/gen-amulet-preapproved.cjs` builds that shape: the receiver's
preapproval (signed by receiver, provider and DSO), the provider's
`FeaturedAppRight`, and the context keys MainNet's registry returns. On the
ledger its event tree matches the MainNet one step for step:
`TransferFactory_Transfer`, `TransferPreapproval_SendV2`, the input archived, a
`FeaturedAppActivityMarker`, two amulets, two `EventLog_HoldingsChange`.
`amulet/gen-amulet-accept.cjs` measures the other route's second step, the
receiver's `TransferInstruction_Accept` on an offer.

Measured 2026-10-21 on a thirteen-participant metered network on a desktop
(16 GB), 30 operations per case, against predictions written beforehand
([PREDICTIONS.md](PREDICTIONS.md), rounds 7 and 8). Bytes billed per transfer.

| DSO on 13 hosts | Paid by the users | Each other DSO host | Mediator | All nodes |
|---|---|---|---|---|
| **Through the receiver's preapproval** | **8,357** (sender) | 494-650 | 151 | **15,675** |
| Offer | 7,464 (sender) | 339-495 | 151 | 13,392 |
| Accept | 7,499 (receiver) | 339-468 | 151 | 12,109 |
| **Offer + accept** | **14,963** | | | **25,501** |

- **At MainNet's list price of $60/MB** (a MainNet traffic purchase on
  2026-10-20: 210,000 B for 120.137 CC at $0.10488), the preapproved transfer
  costs the sender about **$0.50** and the network about $0.94; offer + accept
  costs the users about $0.90.
- **The preapproval saves 44% for the users and 39% for the network**: one
  transaction instead of two, each paying the DSO hosts' confirmations.
- **Predicted:** sender 8,098 B predicted vs 8,357 measured (+3.2%); receiver
  of the accept 7,716 vs 7,499 (−2.8%); Canton's estimate within 0.4% in both.
- **The sender pays about half.** The other half falls on the DSO hosts and
  the mediator.
- With the DSO on one host the preapproved transfer is 5,298 B, the offer
  4,602 B and the accept 4,916 B.
- On this desktop the 13-host cases needed Canton's confirmation deadlines
  raised to 120 s (`cloud/raise-timeouts.canton`); that changes waiting, not
  billing.

## A first cost model, tested by predicting before measuring

A role grid (registry admin and receiver placed independently on nodes 0-2,
transfer metadata empty or random) separated the effects, and five
combinations not used for fitting were then predicted in
`PREDICTIONS.md` before being measured.

What the grid showed:

- **A receiver costs ~1.9 KB only when its node hosts no other party in the
  transaction.** On the admin's node it adds nothing.
- **That ~1.9 KB does not grow with the transaction's data.** With 0, 2,000
  and 4,000 random characters in the transfer, the remote-receiver penalty was
  1,991, 1,885 and 1,948 B. The data itself is billed once, not per node.
- **Data is billed after compression.** 2,000 repeated characters added ~50 B;
  2,000 random hex characters (~1,000 bytes of information) added ~1,300 B.
- **A remote confirming signatory adds ~212 B** to the submitter's bill and
  pays ~250-430 B itself.

The model (submitter's bill):

    base(shape)
    + ~1,930 B (std-spike) / ~2,290 B (Amulet) per node hosting only a receiver
    + ~212 B if a confirming signatory is on another node
    + ~237 B per extra node hosting a confirming party, PER separate part of
      the transaction it receives (so ~474 B each when there is also a
      remote-receiver part). Per NODE, not per party: two confirming parties
      on the same extra node cost the same as one (round 5).
    + ~120 B per extra input holding (round 4)
    + the compressed size of the transaction's own data

What the other nodes pay themselves: a node confirming for one party ~340 B
per transfer, ~160 B more for each additional party it confirms for; a node
that only receives or observes pays nothing.

Tested before measuring: P1-P3 within 1%; P4 failed at +6.5%, which exposed
the per-part interaction; the refined rule then predicted P5 within 0.4%,
where the unrefined rule would have missed by 3.7%. Scope: two transaction
families on one to four participants; untested beyond that.

## Inputs per transfer

A std-spike transfer spending k input holdings, all parties on one
participant, so only k varies (cases `in-1` … `in-8`). The fit on k = 1, 2, 4
predicted k = 3, 6 and 8 before they were measured (PREDICTIONS.md, round 4).

| Inputs | Submitter billed | Estimate | Prepared |
|---|---|---|---|
| 1 | 4,101 | 4,033 | 9,992 |
| 2 | 4,193 | 4,156 | 13,083 |
| 3 | 4,409 | 4,284 | 16,173 |
| 4 | 4,455 | 4,401 | 19,265 |
| 6 | 4,646 | 4,646 | 25,453 |
| 8 | 4,925 | 4,905 | 31,642 |

- **~120 B per extra input**, linear: all three predictions landed within 2%
  billed and within 0.3% on the estimate.
- **The prepared size grows ~3 KB per input**, another 25x overstatement of
  what an input actually costs.
- With production's typical 1-3 inputs per transfer, inputs add 0-240 B: small
  next to the ~2 KB a remote receiver costs.

## Confirming parties or confirming participants?

On MainNet one party (the DSO) is hosted on many nodes. Does the bill follow
the number of confirming PARTIES, or of confirming PARTICIPANTS? A purpose-built
contract answers it: `cosign/`, a `CoAsset` signed by an issuer plus N
co-signers, so every co-signer confirms every transfer. Each co-signer is
hosted on participant 1 plus chosen extra participants (`cosign/run-cosign.sh`).

| Case | Submitter billed | Estimate | What the extra nodes paid |
|---|---|---|---|
| no co-signers | 3,551 | 3,502 | — |
| 1 co-signer, no extra node | 3,780 | 3,634 | — |
| 2 co-signers, no extra node | 4,016 | 3,780 | — |
| 1 co-signer on 1 extra node | 4,019 | 3,868 | 341 |
| 2 co-signers on 2 separate nodes | 4,509 | 4,229 | 341, 341 |
| **2 co-signers on the same extra node** | **4,311** | **4,014** | **501** |
| 3 co-signers on 3 separate nodes | 4,906 | 4,589 | 405, 405, 341 |
| 1 co-signer on 3 extra nodes | 4,459 | 4,318 | 438, 438, 341 |

- **The submitter pays per confirming NODE.** Two co-signers sharing one extra
  node cost the submitter what one does (estimate 4,014 against 4,000
  predicted per node and 4,234 per party). Pre-registered as P15 in
  PREDICTIONS.md, round 5; all five round-5 predictions passed.
- **The confirming node pays per PARTY.** The node hosting two co-signers paid
  501 B against 341 B for one: ~160 B per extra party it confirms for.
- **Each co-signer named in the contract** adds ~230 B (billed) wherever it is
  hosted: it is data in the contract, billed once.
- **Same per-node cost as the DSO series** (~239 B against ~233 B per extra
  confirming node), across two very different transactions.

## Things found on the way

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
- **`$p0` meant a different party on each participant.** Operations rotate
  across participants, and each resolved `$p0`/`$p1` against its own local
  parties. On a 4-node run 3 of every 4 transfers were signed by a party that
  could not see the holding, failed as CONTRACT_NOT_FOUND and were reported as
  contention. Positional references now name the same party on every node
  (test: "positional parties" in `test/placement.test.ts`).
- **Repeated characters are not a size test.** The first data-size run used
  2,000 copies of one character, which compress to almost nothing before
  billing (+50 B). Random data is used instead.
- **Two runs of the same case on different networks shared file names.** A
  smoke test on four participants overwrote two raw reports of the
  eight-participant series. The numbers were already recorded; the two cases
  were re-measured. `measure-table.cjs` now takes a `TAG` (e.g. `TAG=n8`)
  that goes into every result file name, and the scale script sets it.
- **A party with threshold above 1 cannot submit from one participant**
  (`NO_SYNCHRONIZER_ON_WHICH_ALL_SUBMITTERS_CAN_SUBMIT`). The multi-hosted DSO
  therefore uses threshold 1; its extra hosts still confirm.

## Reproduce every result

Commands run from the repository root unless a `cd` says otherwise. Each
measurement prints the billed bytes per transaction, split by node, beside the
estimate and the prepared size, and writes a full report plus a one-line row to
`results/`. Set `JAVA` to a Java 21 binary and, if the SDK lives elsewhere,
`CANTON_JAR`. `OPS` sets transfers per case (default 10).

**1. Pick and boot a metered network.** Wait for `STRESSNET READY (METERED)`.

```bash
cd examples/network
# two participants: the accept and the reference table
java -jar "$APPDATA/daml/sdk/3.4.11/canton/canton.jar" daemon -c two-participants.conf --bootstrap bootstrap-metered.canton --no-tty
# four participants: participant series, Amulet, cost-model grid
java -Xmx3g -jar "$APPDATA/daml/sdk/3.4.11/canton/canton.jar" daemon -c four-participants.conf --bootstrap bootstrap-metered.canton --no-tty
# N participants: the DSO series. Generate, then boot; ~0.6 GB heap per participant
node gen-network.cjs 8
java -Xmx4500m -jar "$APPDATA/daml/sdk/3.4.11/canton/canton.jar" daemon -c participants-8.conf --bootstrap bootstrap-metered.canton --no-tty
```

**2. Upload the DARs to every participant.** Participant i's JSON API is on
port 7000 + 10·i + 1. The settlement app for the accept; the OpenZeppelin
simple-token and std-spike registries for the reference table and the grid;
splice-amulet 0.1.23 for Amulet.

```bash
curl -X POST -H "Content-Type: application/octet-stream" \
  --data-binary @<file>.dar http://localhost:7011/v2/dars     # repeat for each node
```

**3. Run the measurement for each result.**

| Result | Network | Command |
|---|---|---|
| Cross-participant accept | 2 | `bash examples/network/metered/step.sh setup --setup-only`, then `step.sh accepts-20 --ops 20 --warmup 0` |
| Reference table | 2 | `node examples/network/metered/measure-table.cjs oz-propose oz-accept oz-preapproved std-direct std-spread-2 std-spread-4 std-spread-8 std-spread-16`, then `node examples/network/metered/build-table.cjs` |
| Participant series | 4 | `HOLDINGS=120 node examples/network/metered/measure-table.cjs obs-1 obs-2 obs-3 obs-4 conf-2 conf-4` |
| Amulet offer | 4 | `node examples/network/metered/amulet/gen-amulet.cjs`, then `node examples/network/metered/measure-table.cjs amulet-1 amulet-2` |
| Amulet at 13 hosts: preapproved, accept, offer | 13 | `node examples/network/gen-network.cjs 13`; boot `participants-13.conf`; run `cloud/raise-timeouts.canton` with `remote-13.conf`; `node examples/network/metered/amulet/gen-amulet-preapproved.cjs` and `gen-amulet-accept.cjs`; then from `examples/network/metered`: `REMOTE=remote-13.conf KS="1 13" OPS=30 AMULET_CASE=amulet-pre AMULET_FILE=$PWD/amulet/amulet-preapproved.json bash run-dso-series.sh` (`amulet-accept` / `amulet-accept.json` for the accept; no AMULET_* for the offer) |
| DSO on 1..K hosts | N ≥ K | `REMOTE=remote-8.conf KS="1 2 3 4 5 6 7 8" bash examples/network/metered/run-dso-series.sh` |
| Cost-model grid | 4 | `node examples/network/metered/measure-table.cjs <case>…` with the `g-a…-r…-m…` and `g-a…-r…-rand…` cases defined in `measure-table.cjs` |
| Predictions P1-P5 | 4 | `measure-table.cjs P1 P2 P3`; P4 and P5 need a DSO on 3 and 2 hosts: create it with `multihost-dso.canton.tmpl` and pass `DSO=<party id>` |
| Inputs per transfer | 4 | `HOLDINGS=600 node examples/network/metered/measure-table.cjs in-1 in-2 in-3 in-4 in-6 in-8` |
| Parties vs participants | 4 | build `cosign/` (`daml build`), upload its DAR, then `bash examples/network/metered/cosign/run-cosign.sh "c0\|" "local2\|-;-" "c2-same\|2;2" …` (spec format in the script) |
| DSO on 43 hosts | 43 | `examples/network/metered/cloud/run-scale.sh`; see [cloud/README.md](cloud/README.md) |

Set `TAG` (for example `TAG=n8`) to put the network into every result file
name, so the same case measured on different networks never overwrites an
earlier result.

For the accept, billed bytes per accept = (consumed after `accepts-20` −
consumed after `setup`) minus one setup's cost, divided by committed accepts.
`measure-table.cjs` does this subtraction itself for every case: it runs the
case's setup alone, then setup plus the measured transfers, and divides the
difference by the committed count.

`read.sh` asks the sequencer. A participant can also read its own bill from
its own admin API, which is what an operator could do on a real network:
`canton run traffic-state.canton -c remote.conf` (in `examples/network/`).
Both views agreed to the byte (1,050,836 and 77,610).

## Files

In `examples/network/`:

| File | What it is |
|---|---|
| `two-participants.conf`, `four-participants.conf` | Two- and four-participant networks, in memory |
| `gen-network.cjs` | Generates `participants-N.conf` and `remote-N.conf` for any N up to 99 |
| `bootstrap-metered.canton` | Boots any of them with traffic control on and every node funded |
| `remote.conf`, `remote-4.conf`, `remote-N.conf` | Console configs that attach to a running network |
| `traffic-state.canton` | Each participant's own view of its bill |

In `examples/network/metered/`:

| File | What it is |
|---|---|
| `METERED.md` | This write-up |
| `PREDICTIONS.md` | Every prediction, written before its measurement, with results and misses |
| `read.sh`, `seq-state.canton` | Read the bill from the sequencer |
| `step.sh` | One measurement step for the cross-participant accept |
| `measure-table.cjs` | Measures any named case: setup alone, then setup plus transfers, then the difference |
| `build-table.cjs` | Builds the reference table and `results/workload-costs.json` |
| `amulet/gen-amulet.cjs`, `amulet/amulet-transfer.json` | The Canton Coin transfer workload |
| `multihost-dso.canton.tmpl`, `run-dso-series.sh` | Create a DSO hosted on K nodes and measure it |
| `cosign/` | The co-signed asset (Daml), its workload, `multihost-party.canton.tmpl` and `run-cosign.sh` |
| `../../../docs/cost-comparator.html` | The [design cost comparator](https://fronow.github.io/Canton-Stress-Test/docs/cost-comparator.html): a single offline page built on the model here; its constants are pinned by `test/comparator.test.ts` |
| `cloud/run-scale.sh`, `cloud/README.md` | One command for the DSO series on a large rented machine (43 participants) |
| `results/` | Every raw report and per-case row behind every number here |

## Large networks (43 participants)

`cloud/run-scale.sh` generates an N-participant metered network, boots it,
uploads the Amulet DAR to every participant and runs the DSO series for chosen
K, all in one command; `cloud/README.md` lists the machine (64 GB RAM), what to
copy over and how to bring the results back. It was tested end to end on four
participants (`N=4 KS="1 4"`: 4,600 and 5,270 B, matching the earlier
four-node session), then run at 43 participants on a rented 8-vCPU, 64 GB
machine (results above). On that machine the 32-host case needs longer
confirmation deadlines: run `cloud/raise-timeouts.canton` against the running
network before measuring it.

## Limits

- **`readVsWriteScalingFactor = 4` is assumed** to match the Global
  Synchronizer. At this value the recipients term adds well under 1% for two
  recipients, but confirm it against MainNet's published synchronizer
  parameters before quoting absolute numbers.
- **43 participants on one 8-vCPU machine.** The DSO line is measured from 1
  to 43 hosts, but all nodes share one machine and one process, with no real
  network distances; above ~24 hosts the machine was CPU-starved, which may be
  behind the extra ~1 KB per host.
- **The DSO has threshold 1** (see above). The preapproved Amulet transfer
  matches MainNet's event tree, but its config state uses zero holding fees and
  an amulet price of 1.0, the receiver and provider share the sender's node,
  and the accept reads as the sender instead of receiving the locked amulet as
  a disclosed contract. Batched transactions (several transfers in one, as
  some MainNet apps submit) are not measured.
- **Three transaction families.** Token Standard transfers (std-spike,
  OpenZeppelin), Amulet, and a purpose-built co-signed asset. Inputs per
  transfer (1-8) and several confirming parties (up to 3, on up to 4 nodes)
  are measured; other applications are not.
- **Background traffic exists and grows with the network.** Each participant
  gains a few hundred bytes between runs with no transactions running. With
  10 transfers per case it shows as ±100-200 B per node on larger networks;
  use `OPS=30` or more when the per-node split matters.
- **Uploading a DAR is billed** once enforcement is on (2,531 B per
  participant here). The baseline reading absorbs it.
- In memory, one machine. Byte counts do not depend on the machine; timings
  would, and none are claimed here.
