# Gating any CI — GitHub not required

canton-stress gates a build the way every command-line tool does: **it exits
non-zero when an SLA is breached.** Nothing about that is tied to a platform,
a hosted service, or a repository host.

```
node src/cli.ts run <dar> --workload-file <w.json> \
  --min-throughput 15 --max-p99 2000 --max-hotspot-share 50 \
  --report run.json
echo $?      # 0 = within SLA, 1 = breached, 2 = refused to run
```

| exit code | meaning |
|---|---|
| `0` | ran, and every threshold held |
| `1` | ran, and an SLA or regression threshold was breached |
| `2` | refused to run, or the run failed (bad workload, unsafe target, connection) |

That is the entire integration contract. Everything below is a wrapper around
those three lines.

The `action.yml` at the repository root is **optional convenience** for teams
already on GitHub Actions. It is not the product, and nothing depends on it.

---

## GitLab CI

```yaml
perf:
  image: node:24
  variables:
    CANTON_STRESS_TOKEN: $LEDGER_TOKEN     # from GitLab CI/CD variables
  script:
    - node src/cli.ts run "$DAR" --workload-file perf/transfer.json
        --api "$LEDGER_URL" --allow-remote
        --min-throughput 15 --max-p99 2000
        --report run.json --prometheus metrics.prom
    - node src/cli.ts report run.json --out report.html
  artifacts:
    when: always            # the breaching run is the one worth reading
    paths: [run.json, report.html, metrics.prom]
```

## Jenkins (declarative)

```groovy
stage('performance') {
  steps {
    withCredentials([string(credentialsId: 'ledger-token', variable: 'CANTON_STRESS_TOKEN')]) {
      sh '''
        node src/cli.ts run "$DAR" --workload-file perf/transfer.json \
          --api "$LEDGER_URL" --allow-remote \
          --min-throughput 15 --max-p99 2000 --report run.json
        node src/cli.ts report run.json --out report.html
      '''
    }
  }
  post {
    always { archiveArtifacts artifacts: 'run.json,report.html', allowEmptyArchive: true }
  }
}
```

## Plain shell — cron, Make, or anything else

```bash
#!/usr/bin/env bash
set -euo pipefail

node src/cli.ts run "$DAR" --workload-file perf/transfer.json \
  --api "$LEDGER_URL" --allow-remote \
  --min-throughput 15 --max-p99 2000 \
  --report "run-$(date +%F).json"

# Regression against last week's committed baseline
node src/cli.ts report "run-$(date +%F).json" \
  --baseline perf/baseline.json \
  --max-throughput-drop 10 --max-p99-rise 25
```

## Gating on a trend, not a single baseline

A single-baseline gate ("compare to last week's run") is the obvious design and
it **flaps**. One unlucky baseline poisons every later comparison until somebody
re-records it, and teams respond by widening the threshold until the gate stops
meaning anything.

Comparing against the **rolling median of recent runs** is robust to that: a
median is unmoved by one bad afternoon, so a genuine regression still shows.

```bash
node src/cli.ts run "$DAR" --workload-file perf/transfer.json \
  --history perf/history.jsonl --run-label "$GIT_SHA" \
  --max-drop-vs-median 20 --max-p99-rise-vs-median 50
```

```
TREND (4 run(s) in perf/history.jsonl):
  vs median of last 3 run(s): throughput -57.8% (median 11.2/s), p99 -9.4%
TREND: FAIL
  - throughput 57.8% below the median of the last 3 runs (11.2/s; max drop 20%)
```

The history is **JSON Lines** — append-only, one run per line, readable in a
diff, and a corrupt line loses one run rather than the file. Commit it, or keep
it as a CI cache; either works. Inspect it any time:

```
node src/cli.ts trend perf/history.jsonl

  2026-08-03 18:53:34   11.2/s  p99 537.4ms  47.5% cont  build-1
  2026-08-03 18:54:35   11.2/s  p99 641.2ms    45% cont  build-2
  2026-08-03 18:58:59    4.7/s  p99 504.8ms  47.5% cont  build-4-slow
```

With enough runs it also reports **drift** — first third versus last third —
which is the slow decline no two-run comparison can see.

## Feeding a dashboard without any CI at all

`--prometheus` writes the text exposition format, which every Prometheus
deployment can ingest by one of these routes:

- **node_exporter textfile collector** — write into its textfile directory and
  it is scraped with everything else on the host.
- **Pushgateway** — `curl --data-binary @metrics.prom <pushgateway>/metrics/job/canton_stress`.
- **Anything else** — it is plain text; parse it.

```
node src/cli.ts run <dar> ... --prometheus /var/lib/node_exporter/canton_stress.prom \
  --metric-label app=settlement --metric-label env=staging
```

## A note on secrets

Never put a token on the command line — it lands in process listings and CI
logs. Use `CANTON_STRESS_TOKEN`, `--auth-token-file`, or the OAuth flags so the
tool fetches one itself.
