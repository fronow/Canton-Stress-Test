// Declarative workload modeling (roadmap S1). A workload is DATA, not code: a
// party population, an optional setup sequence, and a weighted mix of
// operations. This is what lets a team reproduce THEIR transaction profile
// ("70% transfer / 20% split / 10% redeem across 500 parties") instead of the
// two hard-coded loops the MVP shipped.

import type { ActiveContract, LedgerCommand } from "./ledger.ts";

export interface CreateOp {
  kind: "create";
  /** JSON-API templateId. */
  template: string;
  /** Create payload; string values are substituted per op (see resolvePayload). */
  args: Record<string, unknown>;
}

export interface ExerciseOp {
  kind: "exercise";
  /** templateId (or interfaceId) the choice is exercised on. */
  template: string;
  choice: string;
  /** Choice argument; string values substituted per op. */
  args?: Record<string, unknown>;
  /** The exact contract to exercise on, as a placeholder expression —
   * normally "$ref:<setup id>". REQUIRED in setup, which has no live-contract
   * pool to pick from: a setup program addresses contracts by name. Measured
   * ops leave it out and pick a random live target instead. */
  contract?: string;
  /** Which template's live contracts to pick a target from; defaults to `template`. */
  targetTemplate?: string;
  /** Read the target contract's live set through an interface instead of a
   * template (Token-Standard `Holding` and friends). */
  targetKind?: "template" | "interface";
  /** Submit as the parties named in these fields of the TARGET contract's
   * payload — e.g. ["owner"] so a transfer is signed by whoever actually
   * holds the picked contract, instead of by every party at once. */
  actAsFrom?: string[];
}

export type OpSpec = CreateOp | ExerciseOp;

/** Who submits an op. Party placeholders ($issuer, $party, $pN, $role:x) are
 * resolved like any other payload string. */
export interface Submitters {
  actAs?: string[];
  readAs?: string[];
}

export interface WeightedOp {
  weight: number;
  op: OpSpec;
  /** Per-op submitters. Real apps need these: a transfer is authorized by the
   * owner but often needs the custodian's read authority too. */
  submit?: Submitters;
}

/** One step of the setup program (roadmap S2). Steps run in order, and each
 * can bind what it produced to a name that later steps — and the measured
 * operations — reference as "$ref:<name>". */
export interface SetupStep extends Submitters {
  op: OpSpec;
  /** Bind this step's product under a name. With `count` > 1 the binding is a
   * pool: "$ref:accounts[0]", "$ref:accounts[*]" (random), "$ref:accounts[$i]". */
  id?: string;
  /** Repeat the step this many times. Inside a repetition, "$i" is the index
   * and "$pi" is the party at that index. Default 1. */
  count?: number;
  /** When a choice creates several contracts, bind the one with this template
   * (substring match on the created templateId). Default: the choice's return
   * value if it is a contract id, else the first contract created. */
  bind?: string;
  /** Capture this contract for EXPLICIT DISCLOSURE, and attach it to every
   * measured submission.
   *
   * Needed whenever the measured operation targets a contract the submitter is
   * not a stakeholder of — the normal case for a Token-Standard registry,
   * whose factory is signed by the admin alone. Without this the only way to
   * reach it is to co-submit as the admin, which is not what a wallet does. */
  disclose?: boolean;
}

/** The workload file format this build understands. Bumped only on a BREAKING
 * change to the format — new optional fields do not need it. A saved workload
 * is a reproducibility artefact: it may be re-run months later against a newer
 * canton-stress, and it must either still mean the same thing or say plainly
 * that it does not. */
export const WORKLOAD_FORMAT_VERSION = 1;

export interface Workload {
  /** Format version. Omitted means "written against the current format". */
  version?: number;
  parties: number;
  /** Named parties allocated ALONGSIDE the population, referenced as
   * "$role:custodian". Real apps have asymmetric actors — a custodian, an
   * issuer, an operator — that are not interchangeable load-bearing parties. */
  roles?: string[];
  /** [S6] How parties are spread over the participants given to `--api`.
   *
   *   "first"        every party on the first participant (default; what a
   *                  single-node run has always done).
   *   "round-robin"  party i is hosted by participant i % n.
   *
   * This matters because Canton requires every `actAs` party of a submission
   * to be hosted on the SUBMITTING participant. Spreading parties therefore
   * changes which node can sign what, and a workload that spans participants
   * has to be shaped for it (propose/accept rather than co-signing). */
  placement?: "first" | "round-robin";
  /** [S6] Participant index that hosts each named role. Roles are usually
   * infrastructure actors pinned to one node — an issuer on the issuing
   * participant, a custodian on the custody one. Defaults to 0. */
  rolePlacement?: Record<string, number>;
  /** Run once, sequentially, before the measured window: drive the app into a
   * loadable state. Accepts bare ops (the pre-S2 form) or full steps. */
  setup: Array<SetupStep | OpSpec>;
  /** The measured operation mix. */
  operations: WeightedOp[];
}

/** True for the pre-S2 form, where `setup` was a flat list of ops. */
export function isBareOp(s: SetupStep | OpSpec): s is OpSpec {
  return "kind" in s;
}

/** Normalize either setup form into steps. */
export function toSetupSteps(setup: Array<SetupStep | OpSpec>): SetupStep[] {
  return setup.map((s) => (isBareOp(s) ? { op: s } : s));
}

// ---- parameters -------------------------------------------------------------

/** Values supplied with `--set` / `--set-json`, substituted into a workload
 * before it runs. */
export type WorkloadParams = Record<string, unknown>;

export class ParamError extends Error {}

/** Substitute "$param:<name>" throughout a workload.
 *
 * Done as a pre-pass over the whole document rather than at build time, so a
 * parameter works anywhere — template ids, counts, argument records, party
 * lists — not only inside the places that resolve placeholders at runtime.
 * That is what lets one file describe "a CIP-0056 transfer" and be pointed at
 * a different registry, instead of being an example of one registry.
 *
 * A bare "$param:x" resolves to the VALUE (so it can be an object or a
 * number); embedded in a longer string it is substituted textually.
 *
 * Parameter names are letters, digits, `_` and `.` — deliberately NOT `-`,
 * because "run-$param:name-1" would otherwise greedily read the name as
 * "name-1". */
export function applyParams<T>(doc: T, params: WorkloadParams): T {
  const missing = new Set<string>();
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const whole = /^\$param:([A-Za-z0-9_.]+)$/.exec(v);
      if (whole) {
        if (!(whole[1] in params)) {
          missing.add(whole[1]);
          return v;
        }
        return params[whole[1]];
      }
      return v.replace(/\$param:([A-Za-z0-9_.]+)/g, (m, name: string) => {
        if (!(name in params)) {
          missing.add(name);
          return m;
        }
        const val = params[name];
        return typeof val === "object" ? JSON.stringify(val) : String(val);
      });
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object")
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const out = walk(doc) as T;
  if (missing.size > 0)
    throw new ParamError(
      `workload needs parameters that were not supplied: ${[...missing].sort().join(", ")}\n` +
        `  pass them with --set <name>=<value>, or --set-json <name>='<json>' for records and numbers`,
    );
  return out;
}

/** Parameter names a workload requires, for `check` and for documentation. */
export function requiredParams(doc: unknown, found = new Set<string>()): string[] {
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      for (const m of v.matchAll(/\$param:([A-Za-z0-9_.]+)/g)) found.add(m[1]);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(doc);
  return [...found].sort();
}

// ---- static validation -----------------------------------------------------

/** Every placeholder string anywhere in a value. */
function placeholders(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") {
    if (v.startsWith("$")) out.push(v);
  } else if (Array.isArray(v)) for (const x of v) placeholders(x, out);
  else if (v && typeof v === "object")
    for (const x of Object.values(v as Record<string, unknown>)) placeholders(x, out);
  return out;
}

const opValues = (op: OpSpec): unknown[] =>
  op.kind === "create" ? [op.args] : [op.args, op.contract];

/** Check a workload file before anything is submitted: a mistyped "$ref" or a
 * missing role should fail in milliseconds, not halfway through a setup run
 * against a live ledger. Returns human-readable problems (empty = valid). */
export function validateWorkload(w: Workload): string[] {
  const problems: string[] = [];
  if (w.version !== undefined) {
    if (!Number.isInteger(w.version) || w.version < 1)
      problems.push(`version must be a positive integer (got ${JSON.stringify(w.version)})`);
    else if (w.version > WORKLOAD_FORMAT_VERSION)
      problems.push(
        `this workload declares format version ${w.version}, but this build understands ` +
          `up to ${WORKLOAD_FORMAT_VERSION} — upgrade canton-stress to run it`,
      );
  }
  if (!Number.isInteger(w.parties) || w.parties < 1)
    problems.push(`parties must be a positive integer (got ${JSON.stringify(w.parties)})`);
  if (!Array.isArray(w.setup)) problems.push("setup must be an array");
  if (!Array.isArray(w.operations) || w.operations.length === 0)
    problems.push("operations must be a non-empty array");

  const roles = new Set(w.roles ?? []);
  const checkRefs = (values: unknown[], known: Set<string>, where: string) => {
    for (const p of placeholders(values)) {
      if (p.startsWith("$role:") && !roles.has(p.slice(6)))
        problems.push(`${where}: ${p} — the workload declares no such role (roles: ${[...roles].join(", ") || "none"})`);
      if (p.startsWith("$ref:")) {
        const name = /^\$ref:([A-Za-z0-9_-]+)/.exec(p)?.[1];
        if (!name) problems.push(`${where}: malformed ${p}`);
        else if (!known.has(name))
          problems.push(`${where}: ${p} — no setup step before it binds the id "${name}"`);
      }
    }
  };

  const bound = new Set<string>();
  const steps = Array.isArray(w.setup) ? toSetupSteps(w.setup) : [];
  steps.forEach((step, i) => {
    const where = `setup step ${i + 1}`;
    if (!step.op || !("kind" in step.op)) {
      problems.push(`${where}: missing op`);
      return;
    }
    if (step.op.kind === "exercise") {
      if (!step.op.choice) problems.push(`${where}: exercise op needs a choice`);
      if (!step.op.contract)
        problems.push(
          `${where}: a setup exercise must name its target with "contract": "$ref:<id>" — ` +
            `setup has no live-contract pool to pick from`,
        );
    }
    if (!step.op.template) problems.push(`${where}: op needs a template`);
    if (step.count !== undefined && (!Number.isInteger(step.count) || step.count < 1))
      problems.push(`${where}: count must be a positive integer`);
    // A step may reference its own id (earlier repetitions), so bind first.
    if (step.id) bound.add(step.id);
    checkRefs([...opValues(step.op), step.actAs, step.readAs], bound, where);
  });

  (Array.isArray(w.operations) ? w.operations : []).forEach((wop, i) => {
    const where = `operation ${i + 1}`;
    if (!wop.op || !("kind" in wop.op)) {
      problems.push(`${where}: missing op`);
      return;
    }
    if (typeof wop.weight !== "number" || wop.weight < 0)
      problems.push(`${where}: weight must be a non-negative number`);
    if (!wop.op.template) problems.push(`${where}: op needs a template`);
    if (wop.op.kind === "exercise" && !wop.op.choice) problems.push(`${where}: exercise op needs a choice`);
    checkRefs([...opValues(wop.op), wop.submit?.actAs, wop.submit?.readAs], bound, where);
  });
  if (Array.isArray(w.operations) && w.operations.length > 0 &&
      w.operations.every((o) => (o.weight ?? 0) <= 0))
    problems.push("operation weights must sum to > 0");

  return problems;
}

// ---- payload substitution (shared with the presets in load.ts) ------------

export interface PayloadCtx {
  issuer: string;
  party: () => string;
  parties: string[];
  amount: string;
  /** Named parties, by role name (see Workload.roles). */
  roles?: Record<string, string>;
  /** Contract ids bound by setup steps, by binding name. */
  bindings?: Record<string, string[]>;
  /** The current repetition index inside a `count` setup step. */
  index?: number;
  /** Uniform in [0, 1) — only needed for "$ref:name[*]". */
  rand?: () => number;
  /** Monotonically increasing, one step per call — only needed for
   * "$ref:name[seq]". Shared across concurrent submissions on a context, so
   * consecutive in-flight ops receive distinct pool entries. */
  seq?: () => number;
  /** The payload of the contract an exercise op is targeting ("$target:field"). */
  target?: Record<string, unknown>;
}

export class PlaceholderError extends Error {}

const fail = (msg: string): never => {
  throw new PlaceholderError(msg);
};

/** Resolve "$ref:<name>", "$ref:<name>[<k>]" where k is an integer, "*"
 * (random), "seq" (the next contract in the pool, advancing once per
 * resolution) or "$i" (the enclosing repetition index).
 *
 * "seq" exists to make INPUT SELECTION STRATEGY measurable. A wallet picking
 * an input at random from its own pool collides with itself under concurrency;
 * one that hands each in-flight submission a distinct input does not. The
 * counter is shared across the concurrent submissions on a context, so "seq"
 * models a per-submission reservation, and "*" models the naive strategy. */
function resolveRef(expr: string, ctx: PayloadCtx): string {
  const m = /^([A-Za-z0-9_-]+)(?:\[(\*|\$i|seq|\d+)\])?$/.exec(expr);
  if (!m) return fail(`malformed $ref: "$ref:${expr}"`);
  const [, name, sel] = m;
  const pool = ctx.bindings?.[name];
  if (!pool) return fail(`$ref:${name} — no setup step binds the id "${name}"`);
  if (pool.length === 0)
    return fail(`$ref:${name} — the binding is empty (its setup step created nothing)`);
  if (sel === undefined) return pool[0];
  if (sel === "*") return pool[Math.floor((ctx.rand?.() ?? 0) * pool.length) % pool.length];
  if (sel === "seq") return pool[(ctx.seq?.() ?? 0) % pool.length];
  const i = sel === "$i" ? (ctx.index ?? 0) : Number(sel);
  return pool[i % pool.length];
};

/** Substitute placeholder strings in an argument template, recursively.
 *
 *   $issuer          party 0 of the population
 *   $party           a random party
 *   $p<N>            party N (cycles)
 *   $pi              the party at the current repetition index
 *   $i               that index itself (also substituted inside longer strings)
 *   $amount          the run's amount
 *   $role:<name>     a named party (Workload.roles)
 *   $ref:<name>[k]   a contract id bound by a setup step
 *   $target:<field>  a field of the contract an exercise op is targeting
 *
 * Anything else passes through untouched. */
export function resolvePayload(tpl: unknown, ctx: PayloadCtx): unknown {
  if (typeof tpl === "string") {
    if (tpl === "$issuer") return ctx.issuer;
    if (tpl === "$party") return ctx.party();
    if (tpl === "$amount") return ctx.amount;
    if (tpl === "$pi") return ctx.parties[(ctx.index ?? 0) % ctx.parties.length];
    if (tpl === "$i") return ctx.index ?? 0;
    const p = /^\$p(\d+)$/.exec(tpl);
    if (p) return ctx.parties[Number(p[1]) % ctx.parties.length];
    if (tpl.startsWith("$role:")) {
      const name = tpl.slice(6);
      return ctx.roles?.[name] ?? fail(`$role:${name} — the workload declares no role "${name}"`);
    }
    if (tpl.startsWith("$ref:")) return resolveRef(tpl.slice(5), ctx);
    // The whole party population, for observer/user lists — a Token-Standard
    // factory carries its authorised users this way, and listing them by hand
    // would tie the workload to one party count.
    if (tpl === "$parties") return ctx.parties;
    // Timestamps. Standard transfers carry `requestedAt` / `executeBefore`, so
    // a workload cannot hard-code them: a baked-in time expires the moment the
    // file is saved. "$now", "$now+1h", "$now+30m", "$now-5s".
    if (tpl === "$now" || tpl.startsWith("$now+") || tpl.startsWith("$now-")) {
      const m = /^\$now(?:([+-])(\d+)([smhd]))?$/.exec(tpl);
      if (!m) return fail(`malformed time placeholder "${tpl}"`);
      let ms = 0;
      if (m[2]) {
        const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[3]] ?? 0;
        ms = Number(m[2]) * unit * (m[1] === "-" ? -1 : 1);
      }
      return new Date(Date.now() + ms).toISOString();
    }
    if (tpl.startsWith("$target:")) {
      const field = tpl.slice(8);
      const v = ctx.target?.[field];
      return v === undefined ? fail(`$target:${field} — the target contract has no field "${field}"`) : v;
    }
    // Embedded index, so distinct names can be minted in a repeated step
    // ("instrument-$i"). Done last: standalone forms are handled above.
    if (tpl.includes("$i")) return tpl.replaceAll("$i", String(ctx.index ?? 0));
    return tpl;
  }
  if (Array.isArray(tpl)) return tpl.map((x) => resolvePayload(x, ctx));
  if (tpl && typeof tpl === "object")
    return Object.fromEntries(
      Object.entries(tpl as Record<string, unknown>).map(([k, v]) => [k, resolvePayload(v, ctx)]),
    );
  return tpl;
}

/** Resolve a list of party placeholders to concrete parties, de-duplicated. */
export function resolveParties(refs: string[] | undefined, ctx: PayloadCtx): string[] {
  if (!refs) return [];
  const out = refs.map((r) => {
    const v = resolvePayload(r, ctx);
    if (typeof v !== "string") fail(`"${r}" did not resolve to a party`);
    return v as string;
  });
  return [...new Set(out)];
}

// ---- op selection + command building --------------------------------------

/** Weighted pick from a mix, given a uniform r in [0, 1). Deterministic.
 * Returns the whole entry, because the caller needs its submitters too. */
export function pickOp(ops: WeightedOp[], r01: number): WeightedOp {
  if (ops.length === 0) throw new Error("workload has no operations");
  const total = ops.reduce((s, o) => s + o.weight, 0);
  if (total <= 0) throw new Error("workload operation weights must sum to > 0");
  let x = r01 * total;
  for (const o of ops) {
    if (x < o.weight) return o;
    x -= o.weight;
  }
  return ops[ops.length - 1]; // float-rounding fallback
}

export interface BuildCtx extends PayloadCtx {
  /** Uniform in [0, 1), for choosing a target contract. */
  rand: () => number;
  /** Live contracts available for a template (a pre-fetched snapshot). */
  contractsFor: (template: string) => ActiveContract[];
  /** Every contract id setup bound, precomputed once so recognising contract
   * ids inside choice arguments costs nothing per operation. */
  boundCids?: Set<string>;
}

/** A built command plus the target it was built against — the caller needs the
 * target's payload to work out who should submit (`actAsFrom`). */
export interface BuiltCommand {
  command: LedgerCommand;
  target?: ActiveContract;
  /** Contract ids that appeared in the choice ARGUMENTS (e.g. the input
   * holdings of a Token-Standard transfer). These are usually what actually
   * gets archived, so they are where contention really lives. */
  argumentContractIds?: string[];
}

/** Contract ids reachable in a resolved argument value. A contract id is an
 * opaque string, so this recognises them structurally: Canton ids are long
 * hex-ish strings, and anything that came from a "$ref:" binding is one by
 * construction — which is what the collector below relies on. */
export function collectContractIds(v: unknown, known: Set<string>, out: string[] = []): string[] {
  if (typeof v === "string") {
    if (known.has(v)) out.push(v);
  } else if (Array.isArray(v)) for (const x of v) collectContractIds(x, known, out);
  else if (v && typeof v === "object")
    for (const x of Object.values(v as Record<string, unknown>)) collectContractIds(x, known, out);
  return out;
}

/** Turn one op into a ledger command. Returns null when an exercise op has no
 * live target contract — the caller records that as a skip rather than a
 * bogus submission. */
export function buildCommand(op: OpSpec, ctx: BuildCtx): BuiltCommand | null {
  if (op.kind === "create") {
    return {
      command: {
        CreateCommand: {
          templateId: op.template,
          createArguments: resolvePayload(op.args, ctx),
        },
      },
    };
  }
  // An explicitly named target ("$ref:accounts[$i]") wins: that is how setup
  // chains one step's product into the next.
  if (op.contract !== undefined) {
    const cid = resolvePayload(op.contract, ctx);
    if (typeof cid !== "string")
      return fail(`contract: "${op.contract}" did not resolve to a contract id`);
    const choiceArgument = op.args ? resolvePayload(op.args, ctx) : {};
    return {
      command: {
        ExerciseCommand: {
          templateId: op.template,
          contractId: cid,
          choice: op.choice,
          choiceArgument,
        },
      },
      argumentContractIds: ctx.boundCids
        ? collectContractIds(choiceArgument, ctx.boundCids)
        : undefined,
      // Report the target even when it was named rather than picked, or S4
      // can say nothing about ops addressed this way — which is exactly how a
      // Token-Standard transfer addresses its factory.
      target: { contractId: cid, templateId: op.template, payload: {} },
    };
  }
  const pool = ctx.contractsFor(op.targetTemplate ?? op.template);
  if (pool.length === 0) return null;
  const target = pool[Math.floor(ctx.rand() * pool.length) % pool.length];
  // Args may read the target's own payload ("$target:owner"), so the target
  // has to be chosen before they are resolved.
  const argCtx: BuildCtx = { ...ctx, target: target.payload };
  const choiceArgument = op.args ? resolvePayload(op.args, argCtx) : {};
  return {
    command: {
      ExerciseCommand: {
        templateId: op.template,
        contractId: target.contractId,
        choice: op.choice,
        choiceArgument,
      },
    },
    target,
    argumentContractIds: ctx.boundCids
      ? collectContractIds(choiceArgument, ctx.boundCids)
      : undefined,
  };
}

/** The parties an exercise op must submit as: its declared actAs plus whoever
 * the target contract names in `actAsFrom` fields. */
export function submittersFor(
  op: OpSpec,
  submit: Submitters | undefined,
  target: ActiveContract | undefined,
  ctx: PayloadCtx,
  fallback: string[],
): { actAs: string[]; readAs: string[] } {
  const actAs = resolveParties(submit?.actAs, ctx);
  if (op.kind === "exercise" && op.actAsFrom && target) {
    for (const field of op.actAsFrom) {
      const v = target.payload[field];
      if (typeof v === "string") actAs.push(v);
      else if (Array.isArray(v)) {
        for (const x of v) if (typeof x === "string") actAs.push(x);
      } else fail(`actAsFrom "${field}" — the target contract has no party in that field`);
    }
  }
  return {
    actAs: actAs.length > 0 ? [...new Set(actAs)] : fallback,
    readAs: resolveParties(submit?.readAs, ctx),
  };
}
