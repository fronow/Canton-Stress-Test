# A real multi-participant Canton network

`daml sandbox` gives you **one** participant with an in-process synchronizer.
That is enough to measure an *app*, but not enough to measure a *topology*: it
cannot show party-to-participant placement, cross-participant workflows, or
per-participant latency.

This directory stands up two participants, a sequencer and a mediator on one
synchronizer, using the Canton distribution **already bundled with the Daml
SDK** — no extra download.

## Boot it

```powershell
$canton = "$env:APPDATA\daml\sdk\3.4.11\canton\canton.jar"
$java   = "<your workspace>\tools\jdk-21.0.11+10\bin\java.exe"

cd <this repository>\examples\network
& $java -jar $canton daemon -c two-participants.conf --bootstrap bootstrap.canton --no-tty
```

Wait for:

```
=== STRESSNET READY: participant1 + participant2 on synchronizer 'stressnet' ===
```

| node | JSON Ledger API | gRPC Ledger API | admin |
|---|---|---|---|
| participant1 | `http://localhost:7011` | 5011 | 5012 |
| participant2 | `http://localhost:7021` | 5021 | 5022 |
| sequencer1 | — | 5001 (public) | 5002 |
| mediator1 | — | — | 5003 |

Everything is in-memory: this is a test rig, not a deployment. Stop it with
Ctrl-C (or `Get-Process java | Stop-Process -Force`); all state is discarded.

## Upload a DAR to both participants

Both nodes must know the package, since each interprets the part of a
transaction its parties are involved in:

```powershell
foreach ($p in 7011, 7021) {
  Invoke-RestMethod -Method Post -Uri "http://localhost:$p/v2/dars" `
    -ContentType "application/octet-stream" `
    -InFile "..\settlement-app\.daml\dist\canton-stress-settlement-0.1.0.dar"
}
```

## Run a cross-participant load test

```
node src/cli.ts run --workload-file examples/network/workload-cross-participant.json \
  --api http://localhost:7011,http://localhost:7021 \
  --model closed --concurrency 6 --ops 60
```

`--setup-only` first is worth it — it prints the placement:

```
placement:
  http://localhost:7011: 3 part(ies) — p0, p2, issuer
  http://localhost:7021: 2 part(ies) — p1, p3
```

## Why the workload has the shape it does

**Canton requires every `actAs` party of a submission to be hosted on the
submitting participant.** A single transaction therefore cannot be co-signed by
parties on different nodes — which rules out the co-submission pattern the
single-node settlement workload uses (`owner` + `custodian` together).

Real apps span participants with **propose/accept**:

1. *setup* — the issuer (on participant 1) creates `PaymentOffer` contracts
   whose counterparty is a party hosted on participant 2.
2. *measured* — that counterparty **accepts**, a submission handled by a
   different node against a contract created on the first one.

The second transaction is the one worth measuring: it exercises topology
propagation, cross-participant visibility and commit coordination through the
shared synchronizer.

## How canton-stress places and routes

- `"placement": "round-robin"` spreads the party population across the
  participants given to `--api`; `rolePlacement` pins named roles to a node.
- Each participant gets its **own** view: the party pool `$party` draws from,
  and the contract snapshot targets are picked from, are both node-local —
  because a participant only sees its own parties' projections.
- Every operation is submitted to **the participant hosting its submitter**,
  not to a rotating node. When `actAsFrom` reads the signer off the target
  contract, the contract decides where the transaction must go.

Measured on this rig (60 accepts, concurrency 6): **52 committed, 8 contention,
0 rejected, 15.4 committed/s** — all of them cross-participant.
