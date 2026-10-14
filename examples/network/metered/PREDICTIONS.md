# Cost model v0: predictions written BEFORE measuring

Written 2026-10-12, before any of the cases below was run. The point is the
ordering: these numbers are fixed here first, then measured, and the result
reported whichever way it goes. (Same discipline as the contention law.)

## The model, fitted on the role grid and series measured so far

Submitter's billed bytes for a transfer:

    bill = base(shape)
         + 212   if a confirming signatory (the registry admin) is on another participant
         + ~237  for each EXTRA participant hosting a confirming party (DSO hosts)
         + R     for each participant that hosts only the receiver (no other role)
         + D     for incompressible data in the transaction

Fitted values:

- base: std-spike transfer, 2 parties = 4,097 B; Amulet transfer = 4,601 B
- R (remote receiver on a node with no other role): std-spike 1,928 B
  (mean of 1,991 / 1,885 / 1,948 / 1,889); Amulet 2,293 B (one measurement)
- remote confirming admin: 212 B (submitter side; the admin's node pays
  ~300-400 B itself)
- extra DSO host: 237 B each on the submitter (5,076 - 4,601) / 2
- D: 2,000 random hex chars = 1,311 B; 4,000 = 2,503 B; independent of where
  the receiver is
- R does not depend on the data size; data is billed once, not per node.

## Predictions (submitter's billed bytes per transfer)

| Id | Case | Prediction | Arithmetic |
|---|---|---|---|
| P1 | std-spike: admin on node 1, receiver on node 2, 2,000 random chars | **7,548** | 4,097 + 212 + 1,928 + 1,311 |
| P2 | std-spike: admin on node 1, receiver on node 1, 4,000 random chars | **6,812** | 4,097 + 212 + 0 + 2,503 |
| P3 | std-spike: admin on node 0, receiver on node 2 (node 1 empty) | **6,025** | 4,097 + 1,928 |
| P4 | Amulet: DSO hosted on nodes 0-2, receiver on node 3 | **7,368** | 4,601 + 2 x 237 + 2,293 |

Also predicted: in P1 and P2 the admin's node pays 300-400 B; in P1, P3 and
P4 the receiver-only node pays nothing; in P4 each extra DSO host pays
300-400 B.

Pass criterion, fixed now: a prediction passes if the measured submitter bill
is within 5% of it. Background traffic adds roughly ±100 B of noise per
transfer, so differences under ~100 B are not meaningful.

## Results, round 1 (measured 2026-10-12, after the predictions above)

| Id | Predicted | Measured | Difference | Verdict |
|---|---|---|---|---|
| P1 | 7,548 | 7,488 | −0.8% | pass |
| P2 | 6,812 | 6,799 | −0.2% | pass |
| P3 | 6,025 | 6,052 | +0.4% | pass |
| P4 | 7,368 | 7,846 | +6.5% | **fail** |

Side predictions: receiver-only nodes paid nothing (P1, P3: as predicted).
The admin's node paid 430 B in P1 and 255 B in P2, both outside the 300-400 B
band written above, by less than the ~100 B noise; recorded as misses anyway.

Why P4 failed: DSO on 3 hosts alone bills 5,076 B, which the model got right.
The remote receiver on top of that added 2,770 B, against 2,293 B with the DSO
on one host. So the two effects interact: the receiver's separate part of the
transaction costs more when more nodes host the confirming party. A reading
fitted AFTER the miss (so it does not count yet): each extra confirming host
costs ~237 B per separate part of the transaction it receives, so with a remote
receiver each extra host costs about twice as much.

## Round 2: predictions written BEFORE measuring (2026-10-12)

Refined rule (from the P4 miss): extra confirming host = 237 B x (1 + 1 if
there is a remote-receiver part). Original rule: 237 B per extra host.

| Id | Case | Refined rule predicts | Original rule predicts |
|---|---|---|---|
| P5 | Amulet: DSO hosted on nodes 0-1, receiver on node 3 | **7,368** (4,601 + 2,293 + 237 x 2) | 7,131 (4,601 + 2,293 + 237) |

Pass criterion as before: within 5% of the refined prediction. The test is
only informative if the measurement lands clearly closer to one rule than the
other (they differ by 237 B, about 3%).

## Results, round 2 (measured 2026-10-12, after the prediction above)

| Id | Measured | Refined rule | Original rule | Verdict |
|---|---|---|---|---|
| P5 | 7,397 | 7,368 (+0.4%) | 7,131 (+3.7%) | **pass, refined rule** |

The measurement lands on the refined rule, not the original. Side result: the
extra DSO host paid 444 B, and the receiver-only node paid nothing.

## Where the model stands

Five pre-registered predictions: four passed within 1%, one failed at +6.5%,
and the rule refined from that failure then passed its own pre-registered test
at +0.4%. Fitted on: std-spike transfers and Amulet transfers, one to four
participants. Not yet tested: several confirming parties at once, more inputs
per transfer, featured-app markers, thresholds above 1, more than four nodes.

## Round 3: 5 to 8 DSO hosts, written BEFORE the 8-participant network was booted (2026-10-12)

Fitted ONLY on the DSO-hosting series measured earlier (DSO on 1-4 hosts:
submitter 4,601 / 4,823 / 5,076 / 5,272 B; all participants 4,601 / 5,161 /
5,752 / 6,414 B), by a straight line in the number of extra hosts (K - 1):

    submitter  = 4,603 + 226.6 x (K - 1)
    all nodes  = 4,578 + 603.0 x (K - 1)

| Id | DSO hosted on | Submitter predicted | All participants predicted |
|---|---|---|---|
| P6 | 5 participants | **5,510** | **6,990** |
| P7 | 6 participants | **5,736** | **7,593** |
| P8 | 7 participants | **5,963** | **8,196** |
| P9 | 8 participants | **6,189** | **8,799** |

Also predicted: each extra host pays 300-450 B; the mediator 151 B; a node
that does not host the DSO pays nothing.

Pass criterion: within 5%. Hosts 1-4 are re-measured in the same session as a
check that nothing about the larger network changes them; they are not
predictions.

Why this round matters: the same line, carried to MainNet's 43 Super
Validators, says 14,120 B for the submitter and 29,904 B across the network.
If the line holds to 8 hosts, that extrapolation stands on twice as much
evidence; if it bends, the 43-host figure has to be revised before anyone
quotes it.

## Results, round 3 (measured 2026-10-12, after the predictions above)

Eight-participant network (`participants-8.conf` from `gen-network.cjs`), DSO
hosted on 1-8 participants, 10 transfers per case, all committed.

| Id | DSO hosts | Submitter: predicted → measured | | All nodes: predicted → measured | |
|---|---|---|---|---|---|
| P6 | 5 | 5,510 → 5,603 | +1.7% pass | 6,990 → 7,052 | +0.9% pass |
| P7 | 6 | 5,736 → 5,585 | −2.6% pass | 7,593 → 7,146 | −5.9% **fail** |
| P8 | 7 | 5,963 → 6,147 | +3.1% pass | 8,196 → 8,625 | +5.2% **fail** |
| P9 | 8 | 6,189 → 6,175 | −0.2% pass | 8,799 → 9,120 | +3.6% pass |

Submitter predictions: 4 of 4 pass. All-node predictions: 2 of 4 pass. The
two misses are recorded as misses.

Hosts 1-4 re-measured in the same session as a check: 4,601 / 4,819 / 5,077 /
5,330 B (earlier: 4,601 / 4,823 / 5,076 / 5,272). Side predictions: every
extra host paid between 209 and 531 B, wider than the 300-450 B written above;
the mediator paid 151 B; non-hosting nodes paid nothing (within noise).

Diagnostic, not a prediction: the misses looked like noise (6 hosts measured
below 5; per-host payments jumping between 209 and 531 B; background traffic
between nodes grows with network size and is spread over only 10 transfers).
Hosts 6 and 7 were therefore re-measured with 30 transfers each:

| DSO hosts | Submitter (30 transfers) | vs prediction | All nodes (30 transfers) | vs prediction |
|---|---|---|---|---|
| 6 | 5,813 | +1.3% | 7,863 | +3.6% |
| 7 | 6,038 | +1.3% | 8,156 | −0.5% |

Both land within 5% of the original predictions, which supports noise as the
cause of the misses. (25 of 30 committed in each: the 60-holding pool ran short
of unspent holdings; failed transfers are not sequenced and not billed.)

Canton's own estimate, which has no background noise, rose by 224.6 B per
extra host at every step from 1 to 8 hosts (4,549 → 6,123 B), within 6 B of a
straight line at all eight points.

Fit on all eight points (hosts 6-7 from the 30-transfer re-measure):

| Measure | Per extra host | R² | Largest residual | At 43 hosts (extrapolated) |
|---|---|---|---|---|
| Submitter's bill | 233.3 B | 0.995 | 73 B | 14,413 B |
| All participants | 635.5 B | 0.995 | 208 B | 31,241 B |
| CIP-0104 estimate | 224.6 B | 1.0000 | 6 B | 13,983 B |

The 43-host figures are still an extrapolation (8 measured points, carried
to 43), but they barely moved when the evidence doubled (4-point fit: 14,120 /
29,904 B).

Raw files, recorded honestly: a later smoke test of the cloud script
(4-participant network) wrote its K=1 and K=4 results under the same file
names and overwrote this session's raw reports for those two cases. The
numbers above were already recorded here. The two cases were re-measured on the
eight-participant network (files now tagged `-n8`; the smoke test's are tagged
`-smoke4`): K=1 4,601 B (identical), K=4 5,283 B submitter and 6,297 B all
nodes (against 5,330 / 6,472 in the original session, a difference within the
usual noise). The fits above use the original session's values. The scripts
now take a TAG so runs on different networks can no longer overwrite each
other.

## Round 4: inputs per transfer, written BEFORE measuring 3, 6 and 8 inputs (2026-10-13)

Fitted ONLY on std-spike transfers with 1, 2 and 4 input holdings, all parties
on one participant (submitter billed 4,101 / 4,193 / 4,455 B; estimate 4,033 /
4,156 / 4,401 B), straight line in the number of extra inputs:

    submitter = 4,090 + 119.9 x (inputs - 1)
    estimate  = 4,033 + 122.6 x (inputs - 1)

| Id | Inputs | Submitter predicted | Estimate predicted |
|---|---|---|---|
| P10 | 3 | **4,330** | **4,278** |
| P11 | 6 | **4,689** | **4,646** |
| P12 | 8 | **4,929** | **4,891** |

Pass criterion: submitter within 5%. The estimate predictions are a sharper
test of linearity (the estimate has no background noise): they pass if within
1%. Run with a larger holding pool (HOLDINGS=600) so fewer transfers lose races.

## Results, round 4 (measured 2026-10-13, after the predictions above)

| Id | Inputs | Submitter: predicted → measured | | Estimate: predicted → measured | |
|---|---|---|---|---|---|
| P10 | 3 | 4,330 → 4,409 | +1.8% pass | 4,278 → 4,284 | +0.1% pass |
| P11 | 6 | 4,689 → 4,646 | −0.9% pass | 4,646 → 4,646 | 0.0% pass |
| P12 | 8 | 4,929 → 4,925 | −0.1% pass | 4,891 → 4,905 | +0.3% pass |

All six pass. Each extra input holding adds ~120 B to the bill, linearly from
1 to 8 inputs, while the prepared size grows ~3 KB per input (9,992 → 31,642 B).
Committed: 9, 6 and 7 of 10 (transfers raced for holdings already spent in the
same run; failed transfers are not billed).

## Round 5: confirming parties vs confirming participants, written BEFORE measuring (2026-10-13)

Transaction: transfer of a `CoAsset` (`cosign/`), signed by an issuer plus N
co-signers; every co-signer confirms. Co-signers are hosted on participant1
(Submission) plus chosen extra participants (Confirmation), threshold 1.

Fitted on three cases (submitter billed / estimate):
- no co-signers: 3,551 / 3,502 B
- 1 co-signer, no extra participant: 3,780 / 3,634 B → per co-signer in the
  contract: p = 229 B billed (132 B estimate)
- 1 co-signer on one extra participant: 4,019 / 3,868 B → per extra confirming
  participant: h = 239 B billed (234 B estimate); that participant paid 341 B

(Recorded honestly: a case meant to have 2 local co-signers ran with 1 because
the driver could not express an empty host list; it is used above as the
1-co-signer case. The driver now takes "-" for "no extra participants".)

Two hypotheses. H-node: cost per distinct extra confirming PARTICIPANT.
H-pair: cost per (co-signer, extra participant) PAIR. They differ only when
two co-signers share an extra participant (c2-same).

| Id | Case | H-node billed | H-pair billed | H-node estimate | H-pair estimate |
|---|---|---|---|---|---|
| P13 | 2 co-signers, no extra participants | 4,009 | 4,009 | 3,766 | 3,766 |
| P14 | 2 co-signers on participants 2 and 3 | 4,487 | 4,487 | 4,234 | 4,234 |
| P15 | 2 co-signers both on participant 2 | **4,248** | **4,487** | **4,000** | **4,234** |
| P16 | 3 co-signers on participants 2, 3, 4 | 4,955 | 4,955 | 4,600 | 4,600 |
| P17 | 1 co-signer on participants 2, 3, 4 | 4,497 | 4,497 | 4,336 | 4,336 |

Pass criterion: billed within 5%, estimate within 2%. P15 decides between the
hypotheses: whichever it lands closer to (they differ by ~6%).

## Results, round 5 (measured 2026-10-13, after the predictions above)

| Id | Case | Billed: predicted → measured | Estimate: predicted → measured | Verdict |
|---|---|---|---|---|
| P13 | 2 co-signers, no extra participants | 4,009 → 4,016 (+0.2%) | 3,766 → 3,780 (+0.4%) | pass |
| P14 | 2 co-signers on participants 2, 3 | 4,487 → 4,509 (+0.5%) | 4,234 → 4,229 (−0.1%) | pass |
| P15 | 2 co-signers both on participant 2 | H-node 4,248 / H-pair 4,487 → **4,311** | H-node 4,000 / H-pair 4,234 → **4,014** | **H-node** |
| P16 | 3 co-signers on participants 2, 3, 4 | 4,955 → 4,906 (−1.0%) | 4,600 → 4,589 (−0.2%) | pass |
| P17 | 1 co-signer on participants 2, 3, 4 | 4,497 → 4,459 (−0.8%) | 4,336 → 4,318 (−0.4%) | pass |

All five pass. P15 lands on H-node (+1.5% billed, +0.35% estimate) and well
away from H-pair (−3.9%, −5.2%): **the submitter pays per confirming
PARTICIPANT, not per confirming party.** Two co-signers sharing a node cost the
submitter the same as one.

What the confirming nodes paid themselves: 341 B for one co-signer, 501 B on
the node hosting two (P15), 405-438 B elsewhere. So a confirming node's OWN
bill grows with the number of parties it confirms for (~+160 B per extra
party), while the submitter's bill grows with the number of nodes.

## Round 6: the DSO on up to 43 participants (MainNet scale), written BEFORE the run (2026-10-14)

Run: `cloud/run-scale.sh` with `N=43 KS="1 8 16 24 32 43" OPS=30` on a rented
64 GB machine (cloud/README.md). Hosts 1 and 8 repeat the local measurements as
a check that the larger network changes nothing; 16, 24, 32 and 43 are new.

Predictions come ONLY from the eight-point fit of round 3 (hosts 1-8 on the
local eight-participant network), extended in a straight line:

    submitter  = 4,616 + 233.3 x (K - 1)
    all nodes  = 4,552 + 635.5 x (K - 1)
    estimate   = 4,548 + 224.6 x (K - 1)

| Id | DSO hosts K | Submitter billed | All participants billed | Estimate |
|---|---|---|---|---|
| P18 | 1 (check) | 4,616 | 4,552 | 4,548 |
| P19 | 8 (check) | 6,249 | 9,001 | 6,120 |
| P20 | 16 | **8,116** | **14,085** | **7,917** |
| P21 | 24 | **9,982** | **19,169** | **9,714** |
| P22 | 32 | **11,848** | **24,253** | **11,511** |
| P23 | 43 | **14,415** | **31,243** | **13,981** |

Pass criteria, fixed now: submitter and all-participant bills within 5%;
estimate within 2% (it has no background noise). Each extra host is predicted
to pay between 250 and 550 B itself, and the mediator 151 B.

What a miss would mean: if the 43-host bills land more than 5% away, the
per-host cost is not constant at large K (for example, if fan-out to many
recipients adds cost the four- and eight-node runs could not see), and the
extrapolation quoted until now must be withdrawn and replaced by the measured
figure, whichever direction it goes.

## Results, round 6

(Filled in after the run.)
