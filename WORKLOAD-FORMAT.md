# Workload file format

A workload is **data**, not code: a party population, a **setup program** that
drives the app into a loadable state, and a weighted mix of measured
operations. Pass one with `--workload-file`.

```
node src/cli.ts check <workload.json>          # validate offline, no ledger
node src/cli.ts run <dar> --workload-file <workload.json> --setup-only …
node src/cli.ts run <dar> --workload-file <workload.json> --ops 100 …
```

Complete working examples:

- [`examples/settlement-app/workload.json`](examples/settlement-app/workload.json)
  — a factory-shaped app driven into a loadable state, then settled under load.
- [`examples/settlement-app/workload-hotspot.json`](examples/settlement-app/workload-hotspot.json)
  — the same app with a deliberate shared-`Registry` bottleneck, for seeing
  what the S4 hot-contract attribution reports.

## Why the setup program exists (roadmap S2)

Real Canton apps — daml-finance, the Canton Network Token Standard, any
settlement system — do not let you `create` the interesting contract. You open
an account by exercising a *factory*, credit a holding by exercising the
*account*, and only then is there something worth measuring. Each link in that
chain **returns a contract id the next link needs**.

So a setup step can bind what it produced to a name, and later steps — and the
measured operations — reference it as `$ref:<name>`. That binding table is what
turns a flat list of commands into a program.

## Top level

| Field | Meaning |
|---|---|
| `parties` | Size of the load-bearing party population (`$party`, `$pN`, `$pi`). |
| `roles` | Named parties allocated *alongside* the population — `["custodian", "issuer"]` — referenced as `$role:custodian`. Real apps have asymmetric actors that must not double as random counterparties. |
| `setup` | Ordered steps run once, **not measured**. |
| `operations` | The measured, weighted mix. |

## Setup steps

```json
{
  "id": "accounts",
  "count": 6,
  "actAs": ["$role:custodian"],
  "op": {
    "kind": "exercise",
    "template": "#pkg:Settlement:AccountFactory",
    "contract": "$ref:factory",
    "choice": "OpenAccount",
    "args": { "owner": "$pi" }
  }
}
```

| Field | Meaning |
|---|---|
| `id` | Bind this step's product under a name. With `count` > 1 it is a **pool**. |
| `count` | Repeat the step. Inside a repetition `$i` is the index and `$pi` the party at that index. |
| `actAs` / `readAs` | Who submits. Defaults to party 0 — real apps need this per step (the issuer creates instruments, the custodian opens accounts). |
| `bind` | When a choice creates several contracts, bind the one whose templateId contains this string. Default: the choice's return value if it is a contract id, else the first contract created. |
| `op` | The command — `create` or `exercise`. |

A setup `exercise` **must** name its target with `"contract": "$ref:<id>"`.
Setup has no live-contract pool to pick from: it addresses contracts by name,
which is what makes it deterministic and debuggable.

## Measured operations

```json
{
  "weight": 8,
  "op": {
    "kind": "exercise",
    "template": "#pkg:Settlement:Holding",
    "choice": "Transfer",
    "actAsFrom": ["owner"],
    "args": { "newAccount": "$ref:accounts[*]" }
  },
  "submit": { "actAs": ["$role:custodian"] }
}
```

Measured ops omit `contract` and instead pick a **random live target** from a
snapshot of the ACS taken before the measured window. Extra fields:

| Field | Meaning |
|---|---|
| `targetTemplate` | Pick targets from a different template than the one the choice is on. |
| `targetKind` | `"interface"` to read the live set through an interface (Token-Standard `Holding` and friends). |
| `actAsFrom` | Submit as the parties named in these fields **of the target contract** — so a transfer is signed by whoever actually holds the picked contract, instead of by every party at once. |
| `submit.actAs` / `submit.readAs` | Extra submitters, merged with `actAsFrom`. |

## Placeholders

Resolved recursively through `args`, `contract`, `actAs` and `readAs`.

| Placeholder | Resolves to |
|---|---|
| `$issuer` | Party 0 of the population. |
| `$party` | A random party. |
| `$p<N>` | Party N (cycles). |
| `$pi` | The party at the current repetition index. |
| `$i` | That index — also substituted inside longer strings (`"acct-$i"`). |
| `$amount` | The run's `--amount`. |
| `$role:<name>` | A named party from `roles`. |
| `$ref:<name>` | A contract id bound by a setup step. |
| `$ref:<name>[0]` | Index into a bound pool. |
| `$ref:<name>[*]` | A random member of the pool. |
| `$ref:<name>[$i]` | The member at the current repetition index — pairs a repeated step against an earlier pool. |
| `$target:<field>` | A field of the contract an exercise op is targeting. |

Anything else passes through untouched.

## Validation

`canton-stress check <file>` catches the mistakes that would otherwise waste a
sandbox boot and half a setup run: a mistyped `$ref`, a `$role` the workload
never declares, a forward reference to an id bound by a *later* step, a setup
exercise with no `contract`, weights that sum to zero. `run` applies the same
check before it submits anything.

## What the run reports back (S4)

Every operation carries an attribution — the template, choice, target contract
and submitting parties — so the run can answer the Canton-specific questions a
generic load tool cannot:

| Signal | Flag | What it tells you |
|---|---|---|
| **Hot contracts** | always on | Which contract is losing the races, and what share of all contention sits on the worst one. A workload funnelling through one registry/config/pool contract shows up here even when the global rate looks acceptable. |
| **By operation / by party** | always on | Decomposes a global percentile. Each party sees its own projection, so one party fronting a hot contract can carry the whole tail. |
| **Read-side lag** | `--lag-sample <ms>` | How far the read path trails the write path under load. Reads 0 on a sandbox (it indexes as fast as it commits); the ACS query time is still reported. |
| **Traffic cost (CIP-0104)** | on; `--no-traffic` to skip | Estimated traffic units per operation and per second, from `interactive-submission/prepare` — measured *before* the window so it cannot perturb the run. A synchronizer without traffic control reports **UNMETERED**, not a cost of zero. |

Two CI gates come from this:

```
--max-hotspot-share <pct>   fail if one contract carries more than pct of all contention
--max-read-lag <offsets>    fail if the read path trails by more than this
```

`--max-hotspot-share` catches the regression a contention budget waves through:
overall contention can sit at a comfortable 45% while **100% of it** is one new
bottleneck.

## Running a workload under a test mode (S5)

`--mode ramp|soak|spike|stress` varies the offered load over time instead of
holding it steady. A workload file needs no changes, but one property becomes
decisive:

**A mode needs an unbounded workload.** If every measured operation consumes a
contract from a fixed setup pool, a long run exhausts the pool and what the
mode measures is that exhaustion, not the app's capacity. Measured directly: a
45s ramp against the settlement workload (24 holdings) reported a "cliff" at
3.3 ops/s with 97% contention — the pool had simply run out. Either use
operations that create their own subjects, or size the setup pool for the whole
run (`count` × the duration you intend to drive).

Modes are open-model by construction, because they vary the *offered* load and
a closed model self-paces — there is no offered rate to vary. Soak is the
exception (holding N operations in flight for an hour is a real endurance
test), so it is allowed in both.

## Running it from several processes (S6)

`--workers n` runs the setup program **once** and then fans the measured window
across `n` worker processes, pooling their raw samples. A workload file needs no
changes for this — but two of its properties start to matter:

- **Contract pools should be deep enough for the worker count.** Each worker
  takes its own ACS snapshot and picks targets independently, so `n` workers on
  a shallow pool will collide more than one worker did. That is real contention,
  not an artefact, but it makes runs at different worker counts incomparable
  unless the pool is sized for the load.
- **Ops and the load dimension are split, not multiplied.** `--ops 600
  --concurrency 12 --workers 3` gives each worker 200 ops at concurrency 4; in
  the open model `--rate 30 --workers 3` gives each 10/s, so the *aggregate*
  arrival rate is the 30/s you asked for.

Per-worker and per-endpoint totals are reported alongside the pooled numbers, so
a straggling worker or a lopsided participant is visible rather than averaged
away.

## A note on visibility

If a choice fetches a contract the submitting party is not a stakeholder of,
Canton will reject the command with `CONTRACT_NOT_FOUND` — the submitter's
participant genuinely cannot see it. Add the party that *can* (usually the
custodian or operator) to the op's `submit.actAs`. The settlement example does
exactly this for `Transfer`.
