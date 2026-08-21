# canton-stress — testing guide (what to test, how, on which apps)

> Step-by-step: from zero to a real load/performance test against a Canton app.
> Honest about what the tool can and can't drive today.
>
> This is the **mechanics**. For the *method* — which load model answers your
> question, the traps that produce confident wrong numbers, and how to read the
> results — see **[METHODOLOGY.md](METHODOLOGY.md)**.

---

## 0. Prerequisites (one-time)

- **Daml SDK 3.x** on PATH — `daml`, `damlc`. Check: `daml version`.
- **An OpenJDK** (Temurin 21 works; **Oracle JDK does NOT** — Canton rejects it).
  You already have a portable one at `<your workspace>\tools\jdk-21.0.11+10`.
- **Node ≥ 23.6** — check: `node --version`.
- canton-stress deps installed once: `cd <this repository>; npm install`.

---

## 1. The mental model — what a "test" is here

canton-stress drives **many transactions concurrently** at an app's DAR on a
real ledger and measures:

- **throughput** — committed transactions per second,
- **latency** — submit→commit time, as percentiles (p50/p90/p95/p99/max),
- **contention** — the share of transactions that *raced* and lost (the real
  scaling limit of a hot contract on Canton),
- the **outcome mix** — committed / contention / rejected.

A "test" = pick a workload (what transactions to fire), a concurrency level, and
a count; run it; read the numbers. A *real* test = do that across increasing
load to find where latency/throughput degrade.

### What the MVP can drive today (be honest)

- ✅ **Any template you can `create` directly** — i.e. one whose create
  arguments are plain values (parties, numbers, text), with **no dependency on
  other contracts**. Tokens, IOUs, simple registries, config/among-parties
  contracts. This is the `create` workload.
- ✅ **Any consuming choice on such a template** — the `transfer` workload
  (pre-mints a pool, then races concurrent exercises → contention).
- ⛔ **Not yet: apps that need multi-step setup before anything exists to load**
  — e.g. daml-finance Holdings (need Instrument + Account + custodian first) or
  the Token Standard (mint/transfer go through *factories* and *interfaces*, not
  direct creates). Driving those needs scripted setup workflows = **Phase 2**
  (see DESIGN.md §5). You can still load-test their *simple, directly-creatable*
  templates if any.

---

## 2. Step-by-step: run your first real test

### Step 1 — get a DAR

Either build one (`daml build` in a Daml project → `.daml/dist/<name>.dar`) or
use a prebuilt `.dar`. The bundled smoke target already exists:
`<your workspace>\tool\examples\sample-token\.daml\dist\daml-fuzz-sample-0.1.0.dar`.

### Step 2 — discover what's inside the DAR (templates, choices, arg shapes)

You must know the template's module/entity, its create fields, and (for the
contention workload) a consuming choice + its party field. Two ways:

**Best — reuse the daml-fuzz introspector** (prints templates, party fields,
choices, and argument types):
```
node <your workspace>\tool\src\cli.ts introspect <path-to.dar>
```
Example output line: `Dsl:TokenA — parties [issuer, owner], choices: TransferA(1), SplitA(1)`.

**Or — the SDK's inspector** (also prints the package id, needed for the
non-`#` templateId form):
```
daml damlc inspect-dar <path-to.dar>
```

From this you learn, for the sample token: module `SampleToken`, entity `Token`,
create fields `{issuer, owner, amount}`, consuming choice `Transfer` taking
`newOwner`.

### Step 3 — pick the templateId form

canton-stress takes `--template`. Two accepted forms:
- **Package-name (Daml 3.x, easiest):** `#<package-name>:<Module>:<Entity>`
  e.g. `#daml-fuzz-sample:SampleToken:Token`. No package id needed.
- **Package-id:** `<packageId>:<Module>:<Entity>` (get the id from
  `inspect-dar`). Use this if the `#` form isn't accepted by your ledger.

### Step 4 — run a throughput test (create workload)

One cold-start command (boots a sandbox, runs, tears down):
```
cd <this repository>
node src/cli.ts run <path-to.dar> ^
  --template "#daml-fuzz-sample:SampleToken:Token" ^
  --workload create --parties 3 --ops 200 --concurrency 16 ^
  --sandbox --java-home "<your workspace>\tools\jdk-21.0.11+10" ^
  --report create-report.json
```
For a template whose create args are NOT `{issuer, owner, amount}`, pass the
shape with `--create-args` (placeholders: `$issuer`=party0, `$party`=random,
`$p<N>`=party N, `$amount`):
```
  --create-args "{\"issuer\":\"$issuer\",\"owner\":\"$party\",\"currency\":\"USD\",\"amount\":\"$amount\",\"observers\":[]}"
```

### Step 5 — run a contention test (transfer workload)

```
node src/cli.ts run <path-to.dar> ^
  --template "#daml-fuzz-sample:SampleToken:Token" ^
  --workload transfer --transfer-choice Transfer --new-owner-field newOwner ^
  --parties 3 --ops 60 --concurrency 12 ^
  --sandbox --java-home "<your workspace>\tools\jdk-21.0.11+10" ^
  --report transfer-report.json
```

### Step 6 — read the result

```
RESULT — create workload:
  ops:          200 (200 committed, 0 contention, 0 rejected)
  throughput:   8.3 committed/s  (8.3 attempted/s)
  contention:   0%
  latency (ms): p50 627  p90 8551  p95 8561  p99 8574  max 8578
```
- **throughput** is your write ceiling at this concurrency.
- **p50 vs p99** — a big gap = tail-latency risk (what SLAs care about).
- **contention %** — on `transfer`, a high number means the workload funnels
  through a hot contract; that's the scaling limit to design around.

The full numbers (and the JSON in `--report`) are what you attach to a grant
demo or a capacity-planning discussion.

---

## 3. How to make it a *real* test (not just one run)

One run is a data point; a test is a **curve**. Methodology:

1. **Warm up, then measure.** Do a throwaway run first (JIT, caches, PQS
   priming); trust the second.
2. **Vary ONE dimension** and re-run, holding others fixed:
   - `--concurrency 4, 8, 16, 32, 64` → find where latency's knee is and where
     throughput stops rising (the **cliff**).
   - `--parties 2, 5, 10, 50` → does more parties help (parallelism) or hurt
     (contention/overhead)?
   - `--ops` larger → steadier percentiles; longer soak for drift.
3. **For contention:** run `transfer` at rising `--concurrency` and watch the
   contention % climb — that curve *is* the hot-contract analysis.
4. **Record each run's `--report` JSON**, tabulate throughput/p99/contention vs.
   the dimension you varied. That table is the deliverable.
5. **Compare environments** later: local sandbox now; a real multi-node Canton
   testnet gives production-representative numbers (local sandbox is a floor,
   not a ceiling — its absolute numbers are modest by design).

> The four canonical modes (load / stress / soak / spike) from DESIGN.md §6 are
> the Phase-3 productization of this loop; the MVP already lets you do the core
> "vary concurrency, find the cliff" version by hand.

---

## 4. Best Canton apps to test (ranked, with how to get each)

### Tier 1 — testable right now (directly-creatable templates)

1. **Bundled sample token** — `tool/examples/sample-token`. Already built and
   proven. Your smoke test and the safe demo target.
2. **A `daml new` starter you build yourself.** Run `daml new --list` to see
   templates, `daml new <proj> --template <t>`, add or use a directly-creatable
   token/IOU template, `daml build`. The classic **IOU quickstart** (an `Iou`
   with issuer/owner/currency/amount) is the canonical "real but simple" target
   — directly creatable, exercise `Transfer`. Great for a credible-yet-honest
   demo on "real Daml code."
3. **Any ecosystem app's simple, self-contained templates** — introspect its
   DAR (Step 2); if it has a directly-creatable template, you can load it.

### Tier 2 — high-value, but need Phase-2 setup workflows

4. **daml-finance** (github.com/digital-asset/daml-finance) — the flagship
   finance library (holdings, transfers, settlement). *Real, public, widely
   used* — the best "code you didn't write" target. But Holdings depend on
   Instrument + Account + custodian, so load-testing it means scripting that
   setup first. **Phase 2.**
5. **Canton Network Token Standard (CIP-0056)** — the most ecosystem-relevant
   target (every serious token implements it). You already hold the DARs
   (`<your std-spike checkout>\daml\dars\splice-api-token-*`). Mint/transfer go through
   *factories* and *interfaces*, not direct creates → **Phase 2** (scripted
   factory-driven workflow). This is also the highest-credibility target to name
   in a grant.
6. **Splice / Canton Coin (Amulet)** — complex, rule/factory-based; **Phase 2+**.

### The honest recommendation

For the MVP demo and first real tests: **Tier 1** — the sample token plus an
IOU-style `daml new` build. That proves the tool on real, directly-creatable
Daml without needing the Phase-2 workflow engine. Name **daml-finance** and the
**Token Standard** as the Phase-2 targets in any proposal (they're what makes it
compelling), but don't claim the MVP drives them yet.

---

## 5. Troubleshooting

- **Everything rejected, "template not found" / package errors** → the
  `--template` id is wrong. Re-check module/entity via Step 2; try the
  package-id form (`<pkgId>:Mod:Ent`) if `#name:...` isn't accepted.
- **All rejected with authorization errors** → the create needs a different
  signatory, or the choice controller isn't in `actAs`. For creates the harness
  submits as party 0 (`$issuer`); make sure `$issuer` is a valid signatory. For
  the transfer workload it submits as all parties.
- **`--create-args` JSON on Windows** → escape quotes (`\"`) as in Step 4, or
  put the JSON in a file and pass it inline after reading it.
- **Sandbox won't start / BouncyCastle error** → you're on Oracle JDK; pass
  `--java-home` pointing at OpenJDK.
- **Numbers look low** → a local sandbox is single-node in-memory; treat its
  numbers as a *floor*. Real capacity numbers come from a multi-node testnet.

---

## 6. Quick reference

```
node src/cli.ts run <dar> --template <id> [options]

  --workload create|transfer     create = throughput; transfer = contention
  --parties N                    party population (default 3)
  --ops N                        total operations (default 200)
  --concurrency N                max in-flight submissions (default 16)
  --amount D                     value for $amount (default 100.0)
  --create-args <json>           create payload shape (placeholders above)
  --transfer-choice <name>       consuming choice for transfer (default Transfer)
  --new-owner-field <name>       its party field (default newOwner)
  --seed N                       deterministic workload shape (default 42)
  --sandbox --java-home <dir>    boot a local sandbox from <dar>
  --api <url>                    or target a running participant
  --report <file>                write the full JSON report
```

---

## 8b. Before you point it at anything real

`--dry-run` prints the whole plan — target, setup command count, arrival
profile, workers, and an estimated **total commands submitted** — and submits
nothing. It does not even boot a sandbox, so it costs a second:

```
node src/cli.ts run <dar> --workload-file <w.json> --mode ramp --to 60 --duration 90 --dry-run
```

Two defaults you will meet:

- **A non-local participant is refused** (including `10.x` / `192.168.x` — a
  LAN address is still someone else's box). Pass `--allow-remote` when you mean
  it; the plan is printed before the first command either way.
- **Rate/ops/duration caps** (1000/s, 1e6 ops, 1h) stop a mistyped flag. Each
  refusal names the exact flag that raises it, e.g. `--max-rate 5000`. A ramp
  is checked against its peak, not its starting rate.

---

## 9. When a run fails: which of the three things went wrong

Three unrelated failure classes turned up while validating S5, and they look
similar from the terminal. Telling them apart is the difference between a real
finding and a wasted afternoon.

### a. The hermetic test suite — never fails for environment reasons

`npm test` needs no ledger, no JVM and no network: 75 tests, ~1 second. If it
fails, the cause is logic, not the machine. Every failure seen during S5 was a
genuine defect (in the code or in a fixture's assumptions), for example:

- `byParty` — a co-submitting custodian ties the worst party's p99, so the
  ordering assertion was wrong, not the code.
- `findCliff` — reported a "cliff" in the first bucket of any FLAT run, because
  it never checked that offered load had actually risen. Real detector bug.

**Read a test failure as a claim about the code, and check the claim before
changing the test.**

### b. The sandbox will not boot — almost always memory

```
sandbox exited before becoming ready:
  … Port file was not written to '…canton-portfile.json' before process exit
    with ExitFailure 117
```

This is **not** a canton-stress error: the Canton JVM died during startup. On
this box it happened at **~1 GB free RAM**, after repeated runs left orphaned
`java` processes behind (each holds ~1.8 GB). Diagnose and fix:

```
Get-Process java,daml | Select-Object Id,Name,StartTime      # orphans?
Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 5 Name,@{n='MB';e={[math]::Round($_.WorkingSet64/1mb)}}
Get-Process java,daml | Stop-Process -Force                  # then retry
```

Do this between long sessions. A killed run (Ctrl-C, or a PowerShell pipeline
closed early by `Select-Object -First`) leaves the JVM running, and the *next*
boot is the one that fails.

### c. The run itself breaks under load — that is a RESULT, not an error

At ~400 ops/s offered, a run died with a bare `fetch failed` after ~11,400
operations, discarding every sample collected. That was socket exhaustion in
the load generator's HTTP client — **nothing to do with RAM** — and it was a
defect in canton-stress: a stress test that crashes at the breaking point
destroys the observation it exists to make.

Transport errors are now recorded as data (`TRANSPORT_FAILURE: …`, classified
as rejections, never as contention), so the run completes and the failure shows
up in the verdict. If you see `TRANSPORT_FAILURE` dominating a stress run's
failure mode, the load generator gave out before the ledger did — lower the
rate, or add `--workers` to spread the sockets across processes.

### Quick triage

| symptom | class | what it means |
|---|---|---|
| `npm test` red | (a) | a code or fixture defect — investigate, don't paper over |
| `Port file was not written … ExitFailure 117` | (b) | JVM could not start; free RAM, kill orphaned `java` |
| run aborts mid-flight | (c) | now recorded instead; if seen, it is a finding |
| `PARTICIPANT_BACKPRESSURE` in the verdict | — | the *ledger* refused load: a real capacity answer |
| `TRANSPORT_FAILURE` in the verdict | — | the *generator* gave out first: reduce rate or add workers |
