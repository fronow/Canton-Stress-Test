// Turning an inspected DAR into a runnable load test, with nothing from the user.
//
// This is the half of `canton-stress <dar>` that decides WHAT to measure. It
// deliberately does not invent a workload format: it fills in the parameters of
// the published library template `workloads/token-standard-transfer.json`, the
// same file used for the two registry benchmarks. So the zero-configuration
// path and the hand-driven path run identical code, and the generated
// parameters can be printed, saved and edited when the defaults are wrong.
//
// The scope is deliberate. A general "measure any Daml app" planner would have
// to invent business-meaningful data for arbitrary templates, which is not a
// thing that can be done correctly. A Token Standard registry is different:
// CIP-0056 fixes the measured choice and its argument shape, so the only
// unknowns are how the registry's own holdings and factory are constructed —
// and the DAR describes those.
//
// Where a value cannot be derived, this REFUSES and names the field and type it
// could not synthesise. It never fills a gap with a guess and reports success,
// because a load test that runs on wrong data produces a number that looks
// exactly like a right one.

import type { DarInfo, DarTemplate, DarField } from "./inspect.ts";

/** The parameters of workloads/token-standard-transfer.json. */
export interface TransferParams {
  parties: number;
  holdings: number;
  instrumentId: string;
  transferAmount: string;
  factoryTemplate: string;
  factoryArgs: Record<string, unknown>;
  holdingTemplate: string;
  holdingActAs: string[];
  holdingArgs: Record<string, unknown>;
}

export interface TransferPlan {
  holding: DarTemplate;
  factory: DarTemplate;
  params: TransferParams;
  /** Choices made by heuristic rather than read from the DAR. Shown by
   * --explain, so every inferred value can be checked. */
  notes: string[];
}

export type PlanResult =
  | { ok: true; plan: TransferPlan }
  | { ok: false; reasons: string[] };

/** Defaults for a first run. The holding is worth far more than the transfer,
 * so a single input covers it and the baseline measures ONE input per transfer
 * — the same regime as the published benchmarks. */
const DEFAULTS = {
  parties: 6,
  holdings: 480,
  transferAmount: "1.0",
  holdingAmount: "1000.0",
};

const TRANSFER_DEP = "splice-api-token-transfer-instruction-v1";

const ADMINISH = /^(admin|issuer|custodian|operator|registry|dso|provider)$/i;
const OWNERISH = /^(owner|holder|sender|account|party)$/i;
const INSTRUMENTISH = /instrument/i;

/** A value for one template field, or a reason it could not be produced. */
type Synth = { value: unknown } | { unsupported: string };

const isUnsupported = (s: Synth): s is { unsupported: string } => "unsupported" in s;

function synthField(f: DarField, instrumentId: string, notes: string[]): Synth {
  const t = f.type.trim();

  if (t === "Party") {
    if (ADMINISH.test(f.name)) return { value: "$role:admin" };
    if (OWNERISH.test(f.name)) return { value: "$p0" };
    // Defaulting to the admin is the safer of the two: a create submitted by
    // the admin can always name the admin, whereas naming a wallet party that
    // is not a signatory can fail authorisation.
    notes.push(`field "${f.name}" is a Party with an unrecognised name — using the admin`);
    return { value: "$role:admin" };
  }
  if (/^\[\s*Party\s*\]$/.test(t) || /^List\s+Party$/.test(t)) return { value: "$parties" };

  // Daml encodes Decimal/Numeric as a JSON STRING, and it must stay one: 1.0
  // becoming the number 1 changes what is submitted.
  if (t === "Decimal" || /^Numeric\b/.test(t)) return { value: DEFAULTS.holdingAmount };

  if (t === "Text") {
    if (INSTRUMENTISH.test(f.name)) return { value: instrumentId };
    notes.push(`field "${f.name}" is a free Text — using a placeholder`);
    return { value: "stress" };
  }
  if (/^\[\s*Text\s*\]$/.test(t)) {
    // "supportedInstruments" and friends must contain the instrument the
    // transfer will name, or every transfer is rejected as unsupported.
    if (INSTRUMENTISH.test(f.name)) return { value: [instrumentId] };
    return { value: [] };
  }

  // Token Standard types. Their shapes are fixed by CIP-0056, so hard-coding
  // them is reading a specification, not guessing at an application.
  if (t === "InstrumentId") return { value: { admin: "$role:admin", id: instrumentId } };
  if (t === "Metadata") return { value: { values: {} } };

  if (t === "Int") return { value: 0 };
  if (t === "Bool") return { value: false };
  if (/^Optional\b/.test(t)) return { value: null };
  if (/^\[.*\]$/.test(t)) return { value: [] };
  if (/^(TextMap|Map|GenMap)\b/.test(t) || /\bTextMap\./.test(t)) return { value: {} };

  // A ContractId means this template can only exist downstream of another one,
  // which is a setup CHAIN rather than a flat create. factory-chain.json covers
  // that case, but it cannot be derived without knowing the business flow.
  if (/^ContractId\b/.test(t))
    return { unsupported: `${f.name} : ${t} — needs an existing contract, so it cannot be created directly` };

  return { unsupported: `${f.name} : ${t} — no rule for this type` };
}

function synthArgs(
  tpl: DarTemplate,
  instrumentId: string,
  notes: string[],
  overrides: Record<string, unknown> = {},
): { args: Record<string, unknown> } | { problems: string[] } {
  const args: Record<string, unknown> = {};
  const problems: string[] = [];
  for (const f of tpl.fields) {
    if (f.name in overrides) {
      args[f.name] = overrides[f.name];
      continue;
    }
    const s = synthField(f, instrumentId, notes);
    if (isUnsupported(s)) problems.push(`${tpl.name}.${s.unsupported}`);
    else args[f.name] = s.value;
  }
  return problems.length ? { problems } : { args };
}

/**
 * Decide what to measure in a DAR.
 *
 * Succeeds only for a registry that implements the Token Standard transfer
 * path, which is the case the tool has measured laws for.
 */
export function planTransfer(info: DarInfo): PlanResult {
  const reasons: string[] = [];
  const notes: string[] = [];

  const holdings = info.templates.filter((t) => t.interfaces.includes("Holding"));
  const factories = info.templates.filter((t) => t.interfaces.includes("TransferFactory"));

  if (!info.dependencies.includes(TRANSFER_DEP))
    reasons.push(`it does not depend on ${TRANSFER_DEP}, so it is not a Token Standard registry`);
  if (factories.length === 0)
    reasons.push("no template declares `interface instance TransferFactory`");
  if (holdings.length === 0) reasons.push("no template declares `interface instance Holding`");
  if (reasons.length) return { ok: false, reasons };

  // A registry normally has a locked variant of its holding for allocations.
  // It is a Holding, but it is not the one a wallet spends from.
  const spendable = holdings.filter((t) => !/lock/i.test(t.name));
  if (spendable.length === 0) {
    return {
      ok: false,
      reasons: [
        `every Holding template looks like a locked variant (${holdings.map((h) => h.name).join(", ")}) — ` +
          `cannot tell which one a wallet spends from`,
      ],
    };
  }
  const holding = spendable[0];
  if (spendable.length > 1)
    notes.push(
      `${spendable.length} spendable Holding templates (${spendable.map((h) => h.name).join(", ")}) — measuring ${holding.name}`,
    );
  const factory = factories[0];
  if (factories.length > 1)
    notes.push(
      `${factories.length} TransferFactory templates (${factories.map((f) => f.name).join(", ")}) — measuring ${factory.name}`,
    );

  // A registry that hard-codes its instrument in the Holding view leaves no
  // choice; otherwise any consistent identifier works, since the factory is
  // built to support exactly the one the transfers will name.
  const instrumentId =
    holding.instrumentIdLiteral ?? info.packageName.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (holding.instrumentIdLiteral)
    notes.push(`instrument "${instrumentId}" is fixed by ${holding.name}'s interface view`);

  const h = synthArgs(holding, instrumentId, notes, { owner: "$p0" });
  const f = synthArgs(factory, instrumentId, notes);
  const problems = [
    ...("problems" in h ? h.problems : []),
    ...("problems" in f ? f.problems : []),
  ];
  if (problems.length)
    return {
      ok: false,
      reasons: [`cannot build test data for this registry:`, ...problems.map((p) => `  ${p}`)],
    };
  const holdingArgs = (h as { args: Record<string, unknown> }).args;
  const factoryArgs = (f as { args: Record<string, unknown> }).args;

  // A create must be submitted by every signatory. The signatory list names
  // FIELDS, so each maps to whichever party that field was given.
  let holdingActAs: string[];
  if (holding.signatories.length > 0) {
    holdingActAs = [
      ...new Set(
        holding.signatories.map((s) => {
          const v = holdingArgs[s];
          return typeof v === "string" ? v : "$role:admin";
        }),
      ),
    ];
  } else {
    holdingActAs = ["$role:admin", "$p0"];
    notes.push(
      `${holding.name} computes its signatories, so they could not be read — submitting as both admin and owner`,
    );
  }

  return {
    ok: true,
    plan: {
      holding,
      factory,
      notes,
      params: {
        parties: DEFAULTS.parties,
        holdings: DEFAULTS.holdings,
        instrumentId,
        transferAmount: DEFAULTS.transferAmount,
        factoryTemplate: factory.id,
        factoryArgs,
        holdingTemplate: holding.id,
        holdingActAs,
        holdingArgs,
      },
    },
  };
}
