// Generating a starting workload for ANY Daml application.
//
// `plan.ts` handles Canton Network Token Standard registries completely, because
// CIP-0056 fixes the measured choice and its argument shape. For every other
// application it refuses — correctly, since inventing business-meaningful data
// for arbitrary templates is not something that can be done reliably.
//
// But refusing outright leaves the author with a blank file, which is the step
// most people never take. This module takes the middle path: generate a workload
// that is structurally right and honest about what it guessed, so the author
// edits a draft instead of writing one.
//
// THE INSIGHT THAT MAKES IT POSSIBLE: a DAR states its own dependency graph. A
// template holding a `ContractId T` field cannot be created before a T exists,
// so setup ordering is a topological sort over data already in the DAR — no
// domain knowledge required. What cannot be inferred is business meaning, and
// that is exactly what the TODO markers are for.
//
// The output is deliberately a file the author owns. It is never run without
// being seen: `canton-stress scaffold` writes it and stops.

import type { DarInfo, DarTemplate, DarField, DarChoice } from "./inspect.ts";

/** A note about something the generator could not know. */
export interface ScaffoldNote {
  /** "TemplateName.field" or "TemplateName:ChoiceName". */
  where: string;
  what: string;
}

export interface Scaffold {
  workload: Record<string, unknown>;
  /** Templates created in setup, in dependency order. */
  order: string[];
  /** The operation being measured. */
  measuring: string;
  notes: ScaffoldNote[];
}

export type ScaffoldResult =
  | { ok: true; scaffold: Scaffold }
  | { ok: false; reasons: string[] };

const ADMINISH = /^(admin|issuer|custodian|operator|registry|dso|provider|bank)$/i;
const OWNERISH = /^(owner|holder|sender|from|account|party|user|client)$/i;
/** A party the operation transfers TO. Mapped to a DIFFERENT party than the
 * owner, because `newOwner = owner` is a self-transfer and measures the wrong
 * thing — a workflow that never moves anything between parties. */
const RECEIVERISH = /^(new[A-Z_]|to$|receiver|recipient|beneficiary|counterparty|buyer)/;

/**
 * Order templates so that every template comes after the ones it depends on.
 *
 * Kahn's algorithm. Cycles are possible in Daml (two templates referencing each
 * other) and are reported rather than broken arbitrarily, because a setup
 * program cannot satisfy one and silently dropping an edge would produce a
 * workload that fails at run time for a reason the author cannot see.
 */
export function topoSort(
  templates: DarTemplate[],
): { ok: true; order: string[] } | { ok: false; cycle: string[] } {
  const names = new Set(templates.map((t) => t.name));
  const indeg = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const t of templates) {
    indeg.set(t.name, t.dependsOn.filter((d) => names.has(d)).length);
    for (const d of t.dependsOn) {
      if (!names.has(d)) continue;
      const list = dependents.get(d);
      if (list) list.push(t.name);
      else dependents.set(d, [t.name]);
    }
  }
  // Stable: ties resolve in declaration order, so the same DAR always produces
  // the same file and a regenerated scaffold diffs cleanly.
  const ready = templates.filter((t) => indeg.get(t.name) === 0).map((t) => t.name);
  const order: string[] = [];
  while (ready.length > 0) {
    const n = ready.shift()!;
    order.push(n);
    for (const d of dependents.get(n) ?? []) {
      const left = (indeg.get(d) ?? 1) - 1;
      indeg.set(d, left);
      if (left === 0) ready.push(d);
    }
  }
  if (order.length !== templates.length)
    return { ok: false, cycle: templates.map((t) => t.name).filter((n) => !order.includes(n)) };
  return { ok: true, order };
}

/** A placeholder value for a field, plus a note when it is a guess. */
function valueFor(
  f: DarField,
  owner: string,
  created: Map<string, string>,
  notes: ScaffoldNote[],
  records: Map<string, DarField[]> = new Map(),
  seen: string[] = [],
): unknown {
  const t = f.type.trim();
  const at = (what: string) => notes.push({ where: `${owner}.${f.name}`, what });

  // A contract reference resolves to an earlier setup step — this is the part
  // that makes a generated chain actually run.
  const dep = /\bContractId\s+\(?\s*([A-Za-z][A-Za-z0-9_'.]*)/.exec(t);
  if (dep) {
    const target = dep[1].slice(dep[1].lastIndexOf(".") + 1);
    const bound = created.get(target);
    if (bound) return `$ref:${bound}[$i]`;
    at(`references ${target}, which is not created in setup — supply a contract id`);
    return "TODO:contractId";
  }

  if (t === "Party") {
    if (ADMINISH.test(f.name)) return "$role:admin";
    if (RECEIVERISH.test(f.name)) return "$p1";
    if (OWNERISH.test(f.name)) return "$p0";
    at("Party with an unrecognised name — defaulted to the admin");
    return "$role:admin";
  }
  if (/^\[\s*Party\s*\]$/.test(t)) return "$parties";
  if (t === "Decimal" || /^Numeric\b/.test(t)) return "100.0";
  if (t === "Int") return 0;
  if (t === "Bool") return false;
  if (t === "Text") {
    at("free Text — replace if the application validates it");
    return `${f.name}-1`;
  }
  if (t === "Date" || t === "Time") return "$now";
  if (/^Optional\b/.test(t)) return null;
  if (/^\[.*\]$/.test(t)) return [];
  if (/^(TextMap|Map|GenMap)\b/.test(t) || /\bTextMap\./.test(t)) return {};

  // A record the package declares: build it from the DAR's own `data` or
  // `newtype` declaration rather than emitting a TODO. The values inside are
  // still placeholders, but the SHAPE is right, which is the part an author
  // cannot easily reconstruct by hand.
  const rec = records.get(t);
  if (rec && !seen.includes(t)) {
    const obj: Record<string, unknown> = {};
    for (const sub of rec)
      obj[sub.name] = valueFor(sub, `${owner}.${f.name}`, created, notes, records, [...seen, t]);
    return obj;
  }
  if (rec) {
    at(`type ${t} is recursive (${[...seen, t].join(" → ")}) — supply a value by hand`);
    return `TODO:${t}`;
  }

  // A type from a dependency package, whose sources this DAR does not carry.
  at(`type ${t} — declared outside this package, fill in the record shape`);
  return `TODO:${t}`;
}

/** Who must submit a create: every signatory, mapped through the args. */
function actAsFor(t: DarTemplate, args: Record<string, unknown>): string[] {
  if (t.signatories.length === 0) return ["$role:admin", "$p0"];
  const parties = t.signatories
    .map((s) => args[s])
    .filter((v): v is string => typeof v === "string" && v.startsWith("$"));
  return parties.length > 0 ? [...new Set(parties)] : ["$role:admin"];
}

/** Prefer a consuming choice with the fewest arguments: it is the most likely
 * to be runnable unedited, and a consuming choice is what contention is about.
 * A nonconsuming choice cannot conflict with itself, so measuring one says
 * nothing about contention. */
function pickChoice(t: DarTemplate): DarChoice | undefined {
  const consuming = t.choices.filter((c) => c.consuming);
  const pool = consuming.length > 0 ? consuming : t.choices;
  return [...pool].sort((a, b) => a.fields.length - b.fields.length)[0];
}

/**
 * Build a starting workload for any DAR.
 *
 * Succeeds whenever there is at least one creatable template. The result is a
 * draft: `notes` lists everything that was guessed, and every guess is also
 * marked in the file itself so it cannot be run blind.
 */
export function scaffold(info: DarInfo, opts: { holdings?: number } = {}): ScaffoldResult {
  if (info.templates.length === 0)
    return { ok: false, reasons: ["the DAR declares no templates"] };

  const sorted = topoSort(info.templates);
  if (!sorted.ok)
    return {
      ok: false,
      reasons: [
        `these templates reference each other in a cycle, so no setup order exists: ${sorted.cycle.join(", ")}`,
        "break the cycle by supplying one of the contract ids by hand",
      ],
    };

  const byName = new Map(info.templates.map((t) => [t.name, t]));
  const records = new Map(info.records.map((r) => [r.name, r.fields]));
  const notes: ScaffoldNote[] = [];
  const created = new Map<string, string>();
  const setup: Record<string, unknown>[] = [];
  const count = opts.holdings ?? 200;

  for (const name of sorted.order) {
    const t = byName.get(name)!;
    const args: Record<string, unknown> = {};
    for (const f of t.fields) args[f.name] = valueFor(f, t.name, created, notes, records);
    const bindingId = name.charAt(0).toLowerCase() + name.slice(1);
    created.set(name, bindingId);
    setup.push({
      _comment: `${t.module}:${t.name}`,
      id: bindingId,
      count,
      actAs: actAsFor(t, args),
      op: { kind: "create", template: t.id, args },
    });
  }

  // Measure a choice on the LAST template in dependency order: it is the one
  // furthest downstream, so exercising it is the closest thing to the
  // application's actual workflow that can be inferred.
  const target = [...sorted.order].reverse().map((n) => byName.get(n)!).find((t) => pickChoice(t));
  if (!target)
    return {
      ok: false,
      reasons: [
        "no template declares a choice, so there is nothing to measure",
        "a workload can still be written by hand to measure create throughput — see workloads/create-throughput.json",
      ],
    };

  const choice = pickChoice(target)!;
  const choiceArgs: Record<string, unknown> = {};
  for (const f of choice.fields)
    choiceArgs[f.name] = valueFor(f, `${target.name}:${choice.name}`, created, notes, records);
  if (!choice.consuming)
    notes.push({
      where: `${target.name}:${choice.name}`,
      what: "nonconsuming — it cannot conflict with itself, so this measures throughput but not contention",
    });

  const submitters =
    choice.controllers
      .map((c) => (target.fields.some((f) => f.name === c) ? (setup.find((s) => s.id === created.get(target.name)) as { op: { args: Record<string, unknown> } }).op.args[c] : undefined))
      .filter((v): v is string => typeof v === "string") ?? [];
  if (submitters.length === 0)
    notes.push({
      where: `${target.name}:${choice.name}`,
      what: "controller could not be read — submitting as party 0; change if authorisation fails",
    });

  return {
    ok: true,
    scaffold: {
      order: sorted.order,
      measuring: `${target.name}:${choice.name}`,
      notes,
      workload: {
        _comment: [
          `GENERATED SCAFFOLD for ${info.packageName} ${info.packageVersion}.`,
          "",
          "This is a starting point, not a finished workload. Setup order was",
          "derived from the DAR's own ContractId fields; values marked TODO could",
          "not be inferred and must be filled in. Check it with:",
          "",
          "  canton-stress check <this file>",
          "",
          "and read WORKLOAD-FORMAT.md for what the placeholders mean.",
        ],
        version: 1,
        parties: 6,
        roles: ["admin"],
        setup,
        operations: [
          {
            weight: 1,
            _comment: `measuring ${choice.consuming ? "consuming" : "NONCONSUMING"} choice ${choice.name}`,
            op: {
              kind: "exercise",
              template: target.id,
              choice: choice.name,
              args: choiceArgs,
            },
            submit: { actAs: submitters.length > 0 ? submitters : ["$p0"] },
          },
        ],
      },
    },
  };
}
