// The setup program (roadmap S2): drive a real app into a loadable state
// before the measured window opens.
//
// The MVP could only load templates you can `create` directly. Real Canton
// apps — daml-finance, the Canton Network Token Standard, any settlement
// system — hide the interesting contracts behind a chain of factory choices:
// you open an account by exercising a factory, credit a holding by exercising
// the account, and only then is there something worth measuring. Each link in
// that chain returns a CONTRACT ID the next link needs.
//
// So a setup step can (a) submit as its own parties, (b) repeat with an index,
// and (c) BIND what it produced to a name that later steps and the measured
// operations reference as "$ref:<name>". That binding table is the whole point:
// it is what turns a flat list of commands into a program.

import type { DisclosedContract, LedgerApi } from "./ledger.ts";
import {
  buildCommand,
  resolveParties,
  type BuildCtx,
  type PayloadCtx,
  type SetupStep,
} from "./workload.ts";

/** Contract ids produced by setup, by binding name. */
export type Bindings = Record<string, string[]>;

export interface SetupResult {
  bindings: Bindings;
  /** Commands actually submitted (repetitions included). */
  submitted: number;
  /** Contracts captured for explicit disclosure (steps marked `disclose`). */
  disclosures: DisclosedContract[];
}

export class SetupError extends Error {
  readonly step: number;
  constructor(step: number, message: string) {
    super(`setup step ${step + 1}: ${message}`);
    this.step = step;
  }
}

export interface SetupOptions {
  runId: string;
  /** Uniform in [0, 1) — for "$ref:name[*]" and target picking. */
  rand: () => number;
  /** Fallback submitter when a step does not declare actAs. */
  defaultActAs: string[];
  /** How many repetitions of a step may be in flight at once.
   *
   * Setup is not measured, so there is no methodological reason to serialise
   * it — and at institutional scale it dominates: 100k contracts at ~15/s is
   * two hours before the first measured operation. Steps that reference their
   * own pool stay sequential regardless. */
  concurrency?: number;
  onStep?: (step: number, label: string, bound: number) => void;
}

/** Which contract id a step binds: the choice's return value when it is a
 * contract id, else a created contract — filtered by `bind` when given. */
export function selectBinding(
  created: Array<{ contractId: string; templateId: string }>,
  exerciseResult: unknown,
  bind: string | undefined,
): string | null {
  if (bind) {
    const hit = created.find((c) => c.templateId.includes(bind));
    return hit ? hit.contractId : null;
  }
  // A choice returning `ContractId T` comes back as a bare string. Trust it
  // over node order: it is what the app itself says it produced.
  if (typeof exerciseResult === "string" && created.some((c) => c.contractId === exerciseResult))
    return exerciseResult;
  return created.length > 0 ? created[0].contractId : null;
}

/** Run the setup program in order, returning the bindings it produced.
 *
 * `apiFor` picks the participant a step is submitted to. With one participant
 * it always returns the same client; across a real network it must return the
 * node hosting the step's submitters, because Canton will not accept a
 * submission for a party the receiving participant does not host. */
export async function runSetup(
  apiFor: (actAs: string[]) => LedgerApi,
  steps: SetupStep[],
  base: PayloadCtx,
  o: SetupOptions,
): Promise<SetupResult> {
  const bindings: Bindings = {};
  const disclosures: DisclosedContract[] = [];
  let submitted = 0;

  for (let s = 0; s < steps.length; s++) {
    const step = steps[s];
    const count = step.count ?? 1;
    if (!Number.isInteger(count) || count < 1)
      throw new SetupError(s, `count must be a positive integer, got ${String(step.count)}`);
    const bound: string[] = [];
    let lastSubmitters: string[] = [];

    // A repetition may reference EARLIER repetitions of its own step
    // ("$ref:accounts[$i]" pairing against a pool this step is still filling).
    // Those must stay sequential; everything else can go wide, which is the
    // difference between minutes and hours when a run needs 100k contracts.
    const selfReferential = step.id !== undefined && JSON.stringify(step.op).includes(`$ref:${step.id}`);
    const width = selfReferential ? 1 : Math.max(1, Math.min(o.concurrency ?? 1, count));

    /** One repetition. Returns the contract id it bound, if any. */
    const runRepetition = async (i: number): Promise<string | null> => {
      // Bindings from earlier steps (and earlier repetitions of this one) are
      // visible, so a step can chain off what it just made.
      const ctx: BuildCtx = {
        ...base,
        bindings: { ...bindings, ...(step.id ? { [step.id]: bound } : {}) },
        index: i,
        rand: o.rand,
        // Setup never picks targets from the live ACS: it addresses contracts
        // by name. That is what makes it deterministic and debuggable.
        contractsFor: () => [],
      };

      let built;
      try {
        built = buildCommand(step.op, ctx);
      } catch (e) {
        throw new SetupError(s, e instanceof Error ? e.message : String(e));
      }
      if (!built)
        throw new SetupError(
          s,
          `exercise op has no target — setup steps address contracts by "$ref:<id>", ` +
            `so give the step that creates it an "id" and reference it here`,
        );

      let actAs: string[];
      try {
        actAs = resolveParties(step.actAs, ctx);
      } catch (e) {
        throw new SetupError(s, e instanceof Error ? e.message : String(e));
      }
      const readAs = resolveParties(step.readAs, ctx);

      const submitters = actAs.length > 0 ? actAs : o.defaultActAs;
      lastSubmitters = submitters;
      const res = await apiFor(submitters).submitAndWaitForTree({
        commands: [built.command],
        commandId: `cs-${o.runId}-setup-${s}-${i}`,
        actAs: submitters,
        readAs,
      });
      submitted++;
      if (!res.ok) throw new SetupError(s, res.error);

      if (!step.id) return null;
      const cid = selectBinding(res.created, res.exerciseResult, step.bind);
      if (cid === null)
        throw new SetupError(
          s,
          step.bind
            ? `nothing matching "${step.bind}" was created, so id "${step.id}" cannot be bound`
            : `the step created no contract, so id "${step.id}" cannot be bound`,
        );
      return cid;
    };

    if (width === 1) {
      // Sequential: each repetition can see what the previous one bound.
      for (let i = 0; i < count; i++) {
        const cid = await runRepetition(i);
        if (cid !== null) bound.push(cid);
      }
    } else {
      // Parallel, but results are placed BY INDEX, never by completion order —
      // a later step pairing "$ref:accounts[$i]" against this pool depends on
      // position meaning what it says.
      const placed: (string | null)[] = new Array(count).fill(null);
      let next = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          const i = next++;
          if (i >= count) return;
          placed[i] = await runRepetition(i);
        }
      };
      await Promise.all(Array.from({ length: width }, worker));
      for (const cid of placed) if (cid !== null) bound.push(cid);
    }

    if (step.id) bindings[step.id] = bound;

    // Capture disclosure blobs once, here — never on the measured path.
    // Read them as the step's OWN submitters: a registry factory is signed by
    // the admin alone, so no other party can see it to read the blob.
    if (step.disclose && bound.length > 0) {
      const readers = lastSubmitters.length > 0 ? lastSubmitters : o.defaultActAs;
      const api = apiFor(readers);
      for (const cid of bound) {
        const d = await api.disclosureFor?.(cid, readers);
        if (d) disclosures.push(d);
        else
          throw new SetupError(
            s,
            `"disclose": true but no created-event blob came back for ${cid.slice(0, 16)}… ` +
              `— the participant may not support disclosure, or the submitter cannot read the contract`,
          );
      }
    }
    o.onStep?.(s, describeStep(step), bound.length);
  }

  return { bindings, submitted, disclosures };
}

/** A short human label for a step, for progress output and errors. */
export function describeStep(step: SetupStep): string {
  const what =
    step.op.kind === "create"
      ? `create ${shortTemplate(step.op.template)}`
      : `exercise ${step.op.choice} on ${shortTemplate(step.op.template)}`;
  const n = step.count ?? 1;
  return n > 1 ? `${what} ×${n}` : what;
}

const shortTemplate = (t: string): string => {
  const parts = t.split(":");
  return parts.length >= 3 ? parts.slice(-2).join(":") : t;
};
