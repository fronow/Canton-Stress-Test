# Workload library

Parameterised workload templates, so a team does not start from a blank file —
and so two teams measuring the same thing measure it the *same* way.

A template contains `$param:<name>` placeholders. Ask what it needs:

```
node src/cli.ts check workloads/token-standard-transfer.json
→ template — requires 9 parameter(s):
    --set factoryArgs=<value>
    --set factoryTemplate=<value>
    …
```

Supply them at run time:

| flag | value |
|---|---|
| `--set name=value` | a **string** |
| `--set-json name=<json>` | anything else — numbers, records, arrays |

The distinction is deliberate. `--set` never guesses a type, because a Daml
`Decimal` written `1.0` must stay the string `"1.0"`; silently turning it into
the number `1` would change what is submitted.

Parameter names may contain letters, digits, `_` and `.` — not `-`, since
`run-$param:name-1` would otherwise read the name as `name-1`.

Placeholders resolved at *run* time (`$p0`, `$role:admin`, `$ref:factory`,
`$now+1h`) pass through untouched, so a template can contain both.

---

## The templates

| template | measures | use it when |
|---|---|---|
| `create-throughput.json` | raw write ceiling for one template | **first run against any app** — no setup, no contention, so it bounds everything else |
| `token-standard-transfer.json` | CIP-0056 `TransferFactory_Transfer` | any Token Standard registry |
| `token-standard-allocation.json` | CIP-0056 `AllocationFactory_Allocate` (DvP) | settlement flows on a Token Standard registry |
| `factory-chain.json` | factory → instrument → accounts → holdings, then a choice on a live holding | apps where nothing measurable is directly creatable (daml-finance, custody, settlement) |
| `hot-contract.json` | one shared contract, deliberately | "what does funnelling through a registry/config/counter cost us?" |

Run `create-throughput.json` first and `hot-contract.json` second: the gap
between them is what a shared contract costs, measured rather than guessed.
Against the settlement example the hot-contract probe collapses throughput to
**1/s at 97.5% contention** — the whole run serialised behind one contract.

## `token-standard-transfer.json`

A CIP-0056 transfer against **any** registry implementing `TransferFactory`.
The measured operation is the standard interface choice, so the template does
not need to know anything about the implementation; only the registry's own
factory and holding shapes are parameters.

### Worked example A — a minimal registry

```powershell
node src/cli.ts run <std-spike.dar> --workload-file workloads/token-standard-transfer.json `
  --set-json parties=6 --set-json holdings=400 `
  --set instrumentId=StdToken --set transferAmount=1.0 `
  --set factoryTemplate='#std-spike:StdToken:StdTransferFactory' `
  --set-json factoryArgs='{"admin":"$role:admin","users":"$parties"}' `
  --set holdingTemplate='#std-spike:StdToken:StdHolding' `
  --set-json holdingActAs='["$role:admin"]' `
  --set-json holdingArgs='{"issuer":"$role:admin","owner":"$p0","amount":"1000.0"}' `
  --model closed --concurrency 8 --ops 60 --sandbox --java-home <jdk>
```

### Worked example B — OpenZeppelin's canton-token-template

Same file. Only the parameters change.

```powershell
node src/cli.ts run <simple-token.dar> --workload-file workloads/token-standard-transfer.json `
  --set-json parties=6 --set-json holdings=400 `
  --set instrumentId=SIMPLE --set transferAmount=1.0 `
  --set factoryTemplate='#simple-token:SimpleToken.Rules:SimpleTokenRules' `
  --set-json factoryArgs='{"admin":"$role:admin","supportedInstruments":["SIMPLE"]}' `
  --set holdingTemplate='#simple-token:SimpleToken.Holding:SimpleHolding' `
  --set-json holdingActAs='["$role:admin","$p0"]' `
  --set-json holdingArgs='{"admin":"$role:admin","owner":"$p0","instrumentId":{"admin":"$role:admin","id":"SIMPLE"},"amount":"1000.0","meta":{"values":{}}}' `
  --model closed --concurrency 8 --ops 60 --sandbox --java-home <jdk>
```

### The comparison this makes possible

Both runs above, measured back to back — same workload file, same load model,
same concurrency, same holding pool, same seed:

| | minimal registry | OpenZeppelin template |
|---|---|---|
| committed | 57 / 60 | 57 / 60 |
| throughput | **16.9/s** | **15.8/s** |
| p50 | 364 ms | 375 ms |
| **p99** | **878 ms** | **1126 ms** |
| contention | 5% | 5% |
| dominant failure | `CONTRACT_NOT_FOUND` | `CONTRACT_NOT_FOUND` |

Median latency is effectively identical; the difference is in the **tail**.
OpenZeppelin's implementation does considerably more per transfer — twenty
invariant checks, a three-way dispatch, a locked holding and a transfer
instruction — and that shows up as ~28% higher p99, not as lower median.

Both are bounded by the same thing: `CONTRACT_NOT_FOUND` from concurrent
transfers selecting the same input holding. **Neither registry is the
bottleneck; input selection is.**

That comparison is only meaningful because both sides ran the same file.
Two teams each writing their own harness would not be comparing like with like
— which is the entire reason this directory exists.

*(Single-participant sandbox, one laptop. Floor numbers; the shape is what
transfers, not the rate.)*

---

## `token-standard-allocation.json` — settlement (DvP)

Same parameters as the transfer template, plus `settlementRef` and an
`executor` role. Run both against one registry to price settlement against a
plain transfer. Against OpenZeppelin's template:

| | transfer | allocation (DvP) |
|---|---|---|
| throughput | 15.8/s | **15.4/s** |
| p50 / p99 | 375 / 1126 ms | 357 / 1133 ms |

**Settlement costs essentially nothing extra**, despite locking the asset,
creating an allocation and returning change. Both are bounded by input-holding
selection rather than by the work inside the choice.

## `factory-chain.json` — for apps with nothing directly creatable

Provides the *chain*: factory → instrument → one account per party → holdings
credited into those accounts → a measured choice on a live holding. Each step
binds its product for the next; `$ref:accounts[$i]` pairs each credit with the
account created at the same index.

Verified against the settlement example (6 accounts, 120 holdings,
concurrency 8): **18.1 transfers/s, p99 668 ms, 16.7% contention**.

A note worth having: the first draft of this template omitted the instrument
step, and `check` refused it —

```
- setup step 3: $ref:instrument — no setup step before it binds the id "instrument"
```

— before any ledger was contacted. Forward references in a setup chain are
exactly the mistake that otherwise costs a sandbox boot and half a run.

## Sizing note that applies to every template

If the measured operation **consumes** a contract created during setup, the
pool must survive the whole run. A run attempting more operations than there
are holdings measures pool exhaustion, not the application — see
`METHODOLOGY.md` §3, which shows exactly what that looks like when it goes
wrong.

Rule of thumb: `holdings ≥ ops`, and for a ramp, `holdings ≥ average rate ×
duration`.
