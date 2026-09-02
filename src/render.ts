// Render load results as self-contained HTML (roadmap S7). No scripts, no
// external assets — inline CSS + inline SVG — so a report can be emailed,
// archived, or opened offline. Theme-aware via prefers-color-scheme.
//
//   renderReport(LoadReport)  — one run: percentile chart + stats + outcome mix.
//   renderSweep(SweepReport)  — a sweep: throughput-vs-load and latency-vs-load
//                               curves (the throughput cliff / latency knee).

import type { Instrumentation, LatencySlice } from "./instrument.ts";
import type { LoadReport } from "./load.ts";
import type { Summary } from "./metrics.ts";
import type { ModeReport } from "./modes.ts";
import type { Bucket } from "./timeseries.ts";
import type { SweepReport } from "./sweep.ts";
import { computeVerdict } from "./verdict.ts";

const enc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const r1 = (n: number): string => (Math.round(n * 10) / 10).toString();
const ms = (n: number): string => (n >= 1000 ? `${r1(n / 1000)}s` : `${r1(n)}ms`);

const CSS = `
  :root{color-scheme:light dark;}
  *{box-sizing:border-box;} body{margin:0;}
  .wrap{max-width:860px;margin:0 auto;padding:28px 20px 56px;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#0f172a;background:#f6f8fb;}
  h1{font-size:22px;margin:0 0 4px;} .sub{color:#64748b;font-size:14px;margin:0 0 16px;}
  .chips{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:22px;}
  .chip{background:#fff;border:1px solid #e6eaf1;border-radius:8px;padding:5px 10px;font-size:12.5px;color:#475569;}
  .chip b{color:#0f172a;}
  .verdict{background:#fff;border:1px solid #e6eaf1;border-radius:12px;padding:20px 22px;margin-bottom:22px;}
  .vrow{display:flex;gap:18px;padding:10px 0;border-bottom:1px solid #eef2f7;}
  .vrow:last-child{border-bottom:none;} .vrow:first-child{padding-top:0;}
  .vk{flex:0 0 74px;font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:#94a3b8;font-weight:700;padding-top:3px;}
  .vv{font-size:15px;line-height:1.5;color:#334155;} .vv b{color:#0f172a;font-weight:650;}
  .vmute{color:#64748b;font-size:13.5px;}
  .fix{display:block;font-variant-numeric:tabular-nums;} .arrow{color:#94a3b8;}
  .vnote{display:block;margin-top:6px;}
  .cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px;}
  .cards.two{grid-template-columns:repeat(2,1fr);margin-top:12px;}
  .panel .sub{margin:0 0 10px;} .hint{font-size:11.5px;color:#94a3b8;}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;}
  .card{background:#fff;border:1px solid #e6eaf1;border-radius:12px;padding:14px;}
  .card .label{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#64748b;font-weight:600;}
  .card .value{font-size:22px;font-weight:750;margin-top:6px;letter-spacing:-.01em;}
  .card .hint{font-size:11.5px;color:#94a3b8;margin-top:4px;}
  h2{font-size:14px;margin:22px 0 10px;}
  .panel{background:#fff;border:1px solid #e6eaf1;border-radius:12px;padding:16px;margin-bottom:8px;}
  .chart{width:100%;height:auto;}
  .chart .bar{fill:#4f46e5;} .chart .axis{stroke:#cbd5e1;stroke-width:1;}
  .chart .v{fill:#334155;font-size:11px;} .chart .x{fill:#64748b;font-size:11px;} .chart .y{fill:#94a3b8;font-size:10px;}
  .chart .dot{fill:#fff;stroke-width:2;}
  .legend{display:flex;gap:16px;font-size:12.5px;color:#475569;margin-top:6px;}
  .legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px;vertical-align:middle;}
  .obar{display:flex;height:16px;border-radius:6px;overflow:hidden;background:#eef1f6;margin-bottom:8px;}
  .seg.ok{background:#10b981;} .seg.cont{background:#f59e0b;} .seg.rej{background:#ef4444;}
  table{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px;}
  th,td{text-align:right;padding:7px 10px;border-bottom:1px solid #e6eaf1;} th:first-child,td:first-child{text-align:left;}
  thead th{color:#64748b;font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;}
  footer{margin-top:28px;color:#94a3b8;font-size:12px;border-top:1px solid #e6eaf1;padding-top:14px;}
  @media(prefers-color-scheme:dark){
    .wrap{background:#0b1020;color:#e2e8f0;} h1{color:#fff;}
    .chip,.card,.panel{background:#121a30;border-color:#233150;} .chip b,.card .value{color:#fff;}
    .chart .v{fill:#cbd5e1;} .chart .axis{stroke:#334155;} .obar{background:#233150;}
    th,td{border-color:#233150;} .chart .dot{fill:#121a30;}
  }
  @media(max-width:640px){.cards{grid-template-columns:repeat(2,1fr);}}`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${enc(title)}</title><style>${CSS}</style></head><body><div class="wrap">${body}</div></body></html>`;
}

function card(label: string, value: string, hint = ""): string {
  return `<div class="card"><div class="label">${enc(label)}</div><div class="value">${enc(value)}</div>${hint ? `<div class="hint">${enc(hint)}</div>` : ""}</div>`;
}

// ---- single-run charts -----------------------------------------------------

function latencyChart(curve: { p: number; ms: number }[]): string {
  const W = 640, H = 240, padL = 48, padB = 28, padT = 16;
  const plotW = W - padL - 16, plotH = H - padB - padT;
  const maxMs = Math.max(1, ...curve.map((c) => c.ms));
  const bw = plotW / curve.length;
  const bars = curve
    .map((c, i) => {
      const h = (c.ms / maxMs) * plotH, x = padL + i * bw + bw * 0.15, y = padT + (plotH - h), w = bw * 0.7;
      return `<rect x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}" rx="3" class="bar"/>` +
        `<text x="${r1(x + w / 2)}" y="${r1(y - 4)}" class="v" text-anchor="middle">${ms(c.ms)}</text>` +
        `<text x="${r1(x + w / 2)}" y="${H - padB + 16}" class="x" text-anchor="middle">p${c.p}</text>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="latency percentiles">
    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" class="axis"/>
    <line x1="${padL}" y1="${padT + plotH}" x2="${W - 16}" y2="${padT + plotH}" class="axis"/>
    <text x="8" y="${padT + 8}" class="y">${ms(maxMs)}</text><text x="8" y="${padT + plotH}" class="y">0</text>
    ${bars}</svg>`;
}

function outcomeBar(s: Summary): string {
  const seg = (n: number, cls: string, title: string) =>
    n > 0 ? `<span class="seg ${cls}" style="flex:${n}" title="${title}: ${n}"></span>` : "";
  return `<div class="obar">${seg(s.committed, "ok", "committed")}${seg(s.contention, "cont", "contention")}${seg(s.rejected, "rej", "rejected")}</div>
    <div class="legend"><span><i class="seg ok" style="display:inline-block"></i>committed ${s.committed}</span><span><i class="seg cont" style="display:inline-block"></i>contention ${s.contention}</span><span><i class="seg rej" style="display:inline-block"></i>rejected ${s.rejected}</span></div>`;
}

// ---- [S4] Canton instrumentation -------------------------------------------

const pct = (n: number): string => `${r1(n * 100)}%`;

function sliceTable(
  rows: LatencySlice[],
  firstCol: string,
  keyCell: (s: LatencySlice) => string,
): string {
  const body = rows
    .map(
      (s) =>
        `<tr><td>${keyCell(s)}</td><td>${s.ops}</td><td>${s.contention}</td>` +
        `<td>${pct(s.contentionRate)}</td><td>${ms(s.p50)}</td><td>${ms(s.p99)}</td></tr>`,
    )
    .join("");
  return `<table><thead><tr><th>${enc(firstCol)}</th><th>ops</th><th>contention</th><th>rate</th><th>p50</th><th>p99</th></tr></thead><tbody>${body}</tbody></table>`;
}

/** The Canton-specific section: what a generic load tool cannot tell you. */
function instrumentationSection(i: Instrumentation): string {
  const parts: string[] = [];

  const hot = i.hotspots.filter((h) => h.contention > 0);
  if (hot.length > 0) {
    const conc = i.contentionConcentration;
    const note =
      conc !== undefined && conc >= 0.5
        ? `<p class="sub">One contract carries <b>${pct(conc)}</b> of all contention — a single bottleneck, not broad load.</p>`
        : conc !== undefined
          ? `<p class="sub">Contention is spread: the worst contract carries ${pct(conc)} of it.</p>`
          : "";
    parts.push(
      `<h2>Hot contracts</h2><div class="panel">${note}` +
        sliceTable(hot, "contract", (s) => {
          const h = s as (typeof hot)[number];
          return `<code>${enc(s.key.slice(0, 16))}…</code><br><span class="hint">${enc(shortTemplate(h.template))}</span>`;
        }) +
        `</div>`,
    );
  }

  if (i.byOperation.length > 1)
    parts.push(
      `<h2>By operation</h2><div class="panel">${sliceTable(i.byOperation, "operation", (s) => enc(s.key))}</div>`,
    );

  if (i.byParty.length > 1) {
    const worst = i.byParty[0];
    const best = i.byParty[i.byParty.length - 1];
    const spread =
      best.p99 > 0
        ? `<p class="sub">Worst party's p99 is <b>${r1(worst.p99 / best.p99)}×</b> the best party's — each party sees its own projection, so a global percentile hides this.</p>`
        : "";
    parts.push(
      `<h2>Per-party latency</h2><div class="panel">${spread}` +
        sliceTable(i.byParty, "party", (s) => `<code>${enc(s.key.split("::")[0])}</code>`) +
        `</div>`,
    );
  }

  const extra: string[] = [];
  if (i.readLag)
    extra.push(
      card(
        "Read-side lag",
        `${i.readLag.maxOffsetLag}`,
        `max offsets behind · mean ${r1(i.readLag.meanOffsetLag)} · query p99 ${ms(i.readLag.p99QueryMs)}`,
      ),
    );
  if (i.traffic) {
    extra.push(
      i.traffic.unmetered
        ? card("Traffic cost", "unmetered", "no traffic control on this synchronizer")
        : card("Traffic cost", `${i.traffic.totalForRun}`, `units for the run · ${r1(i.traffic.perSecond)}/s`),
    );
    // Envelope size is measurable even where CIP-0104 cost is not, which is why
    // it is reported separately rather than folded into the card above.
    const t = i.traffic;
    if (t.preparedBytesPerOp !== undefined) {
      const kb = (b: number) => (b < 1024 ? `${Math.round(b)} B` : `${r1(b / 1024)} KB`);
      extra.push(
        card(
          "Envelope size",
          kb(t.preparedBytesPerOp),
          // card() escapes its hint, so this is plain text by necessity.
          t.costPerOpUsd !== undefined
            ? `$${t.costPerOpUsd.toFixed(4)} per operation at $${t.usdPerMb}/MB`
            : "per operation · pass --traffic-price to price it",
        ),
      );
    }
  }
  if (extra.length > 0) parts.push(`<div class="cards two">${extra.join("")}</div>`);

  if (parts.length === 0) return "";
  return (
    `<h2>Canton instrumentation</h2>` +
    `<p class="sub">Contention attribution, per-party latency, read-side lag and traffic cost — the Canton-specific answers a generic load tool cannot give.</p>` +
    parts.join("")
  );
}

const shortTemplate = (t: string): string => {
  const parts = t.split(":");
  return parts.length >= 3 ? parts.slice(-2).join(":") : t;
};

// ---- [S5] behaviour over time ----------------------------------------------

/** Offered load, achieved throughput and p99 against time — the picture a
 * ramp/soak/spike run exists to produce. Dual axis: rates on the left, latency
 * on the right, since they share no scale. */
function timeSeriesChart(buckets: Bucket[]): string {
  const W = 640, H = 260, padL = 46, padR = 46, padB = 30, padT = 16;
  const plotW = W - padL - padR, plotH = H - padB - padT;
  const n = buckets.length;
  const maxRate = Math.max(1, ...buckets.map((b) => Math.max(b.offeredPerSec, b.throughputPerSec)));
  const maxP99 = Math.max(1, ...buckets.map((b) => b.p99));
  const xAt = (i: number) => padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const yRate = (v: number) => padT + (plotH - (v / maxRate) * plotH);
  const yLat = (v: number) => padT + (plotH - (v / maxP99) * plotH);

  const line = (ys: number[], color: string, dashed = false) =>
    `<polyline points="${ys.map((v, i) => `${r1(xAt(i))},${r1(v)}`).join(" ")}" fill="none" ` +
    `stroke="${color}" stroke-width="2"${dashed ? ' stroke-dasharray="4 3"' : ""}/>`;

  const ticks = buckets
    .map((b, i) =>
      i % Math.max(1, Math.round(n / 6)) === 0
        ? `<text x="${r1(xAt(i))}" y="${H - padB + 16}" class="x" text-anchor="middle">${r1(b.tMs / 1000)}s</text>`
        : "",
    )
    .join("");

  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="load and latency over time">
    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" class="axis"/>
    <line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" class="axis"/>
    <text x="6" y="${padT + 8}" class="y">${r1(maxRate)}/s</text>
    <text x="${W - padR + 6}" y="${padT + 8}" class="y">${ms(maxP99)}</text>
    ${line(buckets.map((b) => yRate(b.offeredPerSec)), "#94a3b8", true)}
    ${line(buckets.map((b) => yRate(b.throughputPerSec)), "#4f46e5")}
    ${line(buckets.map((b) => yLat(b.p99)), "#f59e0b")}
    ${ticks}</svg>
    <div class="legend"><span><i style="background:#94a3b8"></i>offered/s</span><span><i style="background:#4f46e5"></i>committed/s</span><span><i style="background:#f59e0b"></i>p99</span></div>`;
}

function modeSection(m: ModeReport): string {
  const cards: string[] = [];
  if (m.knee) cards.push(card("Latency knee", `${r1(m.knee.offeredPerSec)}/s`, `p99 ${ms(m.knee.baselineP99)} → ${ms(m.knee.p99)}`));
  if (m.cliff) cards.push(card("Throughput cliff", `${r1(m.cliff.offeredPerSec)}/s`, `peaks at ${r1(m.cliff.peakThroughputPerSec)} committed/s`));
  if (m.drift)
    cards.push(
      card("Drift", `${m.drift.p99ChangePct >= 0 ? "+" : ""}${r1(m.drift.p99ChangePct)}%`, `p99 first vs last quarter`),
      card("Throughput drift", `${m.drift.throughputChangePct >= 0 ? "+" : ""}${r1(m.drift.throughputChangePct)}%`, "committed/s, first vs last"),
    );
  if (m.recovery)
    cards.push(
      m.recovery.recovered
        ? card("Recovery", `${r1((m.recovery.recoveredAfterMs ?? 0) / 1000)}s`, `after the burst ended`)
        : card("Recovery", "none", "still elevated when the run ended"),
    );
  if (m.breakingPoint)
    cards.push(card("Breaking point", `${r1(m.breakingPoint.offeredPerSec)}/s`, enc(m.breakingPoint.failureMode)));

  return (
    `<h2>${enc(m.mode)} — behaviour over time</h2>` +
    `<p class="sub">${enc(m.verdict)}</p>` +
    (cards.length > 0 ? `<div class="cards two">${cards.join("")}</div>` : "") +
    `<div class="panel">${timeSeriesChart(m.buckets)}</div>`
  );
}

/**
 * The answer, above the evidence.
 *
 * A report that opens with percentile tables asks the reader to interpret it.
 * Most people who receive one of these did not run it and are not going to
 * interpret anything — so the verdict, its cause and the sized remedy go first,
 * and the distribution stays underneath for whoever wants to check the working.
 *
 * Rendered from the same `computeVerdict` the terminal uses, so the two cannot
 * drift apart.
 */
function verdictSection(report: LoadReport): string {
  const m = computeVerdict({
    summary: report.summary,
    instrumentation: report.instrumentation,
    pool: report.shape?.pool,
    inputs: report.shape?.inputs,
    subject: report.shape?.subject,
    noun: report.shape?.noun,
  });

  const rows: string[] = [
    `<div class="vrow"><span class="vk">Verdict</span><span class="vv"><b>${enc(m.throughput)}</b>` +
      (m.headline ? `<br>${enc(m.headline)}` : "") +
      (m.rejected ? `<br><span class="vmute">${enc(m.rejected)}</span>` : "") +
      `</span></div>`,
  ];

  if (m.why)
    rows.push(
      `<div class="vrow"><span class="vk">Why</span><span class="vv"><b>${enc(m.why.title)}</b><br>` +
        `${enc(m.why.detail)}` +
        (m.why.failureMode ? `<br><span class="vmute">Dominant failure: ${enc(m.why.failureMode)}</span>` : "") +
        `</span></div>`,
    );

  if (m.fixes.length > 0)
    rows.push(
      `<div class="vrow"><span class="vk">Fix</span><span class="vv">` +
        m.fixes
          .map((f) => `<span class="fix"><b>${enc(f.action)}</b> <span class="arrow">→</span> ${enc(f.result)}</span>`)
          .join("") +
        (m.fixNote ? `<span class="vmute vnote">${enc(m.fixNote)}</span>` : "") +
        `</span></div>`,
    );

  return `<div class="verdict">${rows.join("")}</div>`;
}

export function renderReport(report: LoadReport): string {
  const s = report.summary;
  const rateLine =
    report.model === "open"
      ? `target ${report.targetRatePerSec}/s · achieved ${r1(report.achievedRatePerSec ?? 0)}/s`
      : "self-paced (closed model)";
  // [S2] Say what state the numbers were measured against: a throughput figure
  // is only meaningful next to the app state that produced it.
  const setupChip = report.setup
    ? [
        `setup: <b>${report.setup.submitted} cmds / ${report.setup.steps} steps</b>` +
          (Object.keys(report.setup.bindings).length > 0
            ? ` (${enc(
                Object.entries(report.setup.bindings)
                  .map(([k, v]) => `${k}×${v}`)
                  .join(", "),
              )})`
            : ""),
      ]
    : [];
  const chips = [
    `model: <b>${enc(report.model)}</b>`,
    `parties: <b>${report.parties}</b>`,
    `ops: <b>${s.ops}</b>`,
    `arrival: <b>${enc(rateLine)}</b>`,
    ...setupChip,
  ]
    .map((c) => `<span class="chip">${c}</span>`)
    .join("");
  const body = `<h1>canton-stress — load report</h1>
  <p class="sub">Throughput, latency percentiles and contention for a Canton app under load.</p>
  <div class="chips">${chips}</div>
  ${verdictSection(report)}
  <div class="cards">
    ${card("Throughput", `${r1(s.throughputPerSec)}/s`, "committed / sec")}
    ${card("p99 latency", ms(s.latency.p99), `p50 ${ms(s.latency.p50)}`)}
    ${card("Contention", `${r1(s.contentionRate * 100)}%`, `${s.contention} of ${s.ops}`)}
    ${card("Committed", `${s.committed}/${s.ops}`, `${s.rejected} rejected`)}
  </div>
  ${report.modeReport ? modeSection(report.modeReport) : ""}
  <h2>Latency percentiles</h2><div class="panel">${latencyChart(s.latencyCurve)}</div>
  <h2>Outcome mix</h2><div class="panel">${outcomeBar(s)}</div>
  ${report.instrumentation ? instrumentationSection(report.instrumentation) : ""}
  <footer>Measured over ${ms(s.wallMs)} wall time. Open-model latency is measured from each operation's scheduled arrival (coordinated-omission correct). Apache-2.0.</footer>`;
  return page("canton-stress report", body);
}

// ---- sweep charts ----------------------------------------------------------

function lineChart(o: {
  xs: number[];
  series: { name: string; color: string; ys: number[] }[];
  yfmt: (n: number) => string;
  ariaLabel: string;
}): string {
  const W = 640, H = 240, padL = 52, padB = 30, padT = 16;
  const plotW = W - padL - 16, plotH = H - padB - padT;
  const maxY = Math.max(1, ...o.series.flatMap((s) => s.ys));
  const n = o.xs.length;
  const xAt = (i: number) => padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const yAt = (v: number) => padT + (plotH - (v / maxY) * plotH);
  const lines = o.series
    .map((s) => {
      const pts = s.ys.map((v, i) => `${r1(xAt(i))},${r1(yAt(v))}`).join(" ");
      const dots = s.ys.map((v, i) => `<circle cx="${r1(xAt(i))}" cy="${r1(yAt(v))}" r="3.5" class="dot" style="stroke:${s.color}"/>`).join("");
      return `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2"/>${dots}`;
    })
    .join("");
  const xlabels = o.xs.map((x, i) => `<text x="${r1(xAt(i))}" y="${H - padB + 16}" class="x" text-anchor="middle">${x}</text>`).join("");
  const legend = o.series
    .map((s) => `<span><i style="background:${s.color}"></i>${enc(s.name)}</span>`)
    .join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="${enc(o.ariaLabel)}">
    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" class="axis"/>
    <line x1="${padL}" y1="${padT + plotH}" x2="${W - 16}" y2="${padT + plotH}" class="axis"/>
    <text x="8" y="${padT + 8}" class="y">${enc(o.yfmt(maxY))}</text><text x="8" y="${padT + plotH}" class="y">0</text>
    ${lines}${xlabels}</svg><div class="legend">${legend}</div>`;
}

export function renderSweep(sweep: SweepReport): string {
  const xs = sweep.points.map((p) => p.level);
  const thr = sweep.points.map((p) => p.report.summary.throughputPerSec);
  const p50 = sweep.points.map((p) => p.report.summary.latency.p50);
  const p99 = sweep.points.map((p) => p.report.summary.latency.p99);
  const dim = sweep.dimension === "rate" ? "target rate (ops/s)" : "concurrency";

  const rows = sweep.points
    .map((p) => {
      const s = p.report.summary;
      return `<tr><td>${p.level}</td><td>${r1(s.throughputPerSec)}</td><td>${ms(s.latency.p50)}</td><td>${ms(s.latency.p99)}</td><td>${r1(s.contentionRate * 100)}%</td></tr>`;
    })
    .join("");

  const body = `<h1>canton-stress — load sweep</h1>
  <p class="sub">Behaviour across increasing ${enc(dim)}: where throughput plateaus (the cliff) and latency climbs (the knee).</p>
  <div class="chips"><span class="chip">dimension: <b>${enc(sweep.dimension)}</b></span><span class="chip">levels: <b>${xs.join(", ")}</b></span></div>
  <h2>Throughput vs ${enc(dim)}</h2>
  <div class="panel">${lineChart({ xs, series: [{ name: "committed/s", color: "#4f46e5", ys: thr }], yfmt: (n) => `${r1(n)}/s`, ariaLabel: "throughput vs load" })}</div>
  <h2>Latency vs ${enc(dim)}</h2>
  <div class="panel">${lineChart({ xs, series: [{ name: "p50", color: "#10b981", ys: p50 }, { name: "p99", color: "#ef4444", ys: p99 }], yfmt: ms, ariaLabel: "latency vs load" })}</div>
  <h2>Points</h2>
  <div class="panel"><table><thead><tr><th>${enc(sweep.dimension)}</th><th>throughput/s</th><th>p50</th><th>p99</th><th>contention</th></tr></thead><tbody>${rows}</tbody></table></div>
  <footer>Open-model latency is coordinated-omission correct. Apache-2.0.</footer>`;
  return page("canton-stress sweep", body);
}
