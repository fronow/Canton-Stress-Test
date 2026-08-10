// Minimal Canton JSON Ledger API v2 client — plain Node fetch, zero deps.
//
// Canton 3.x participants expose the Ledger API over HTTP/JSON ("JSON API
// v2", `daml sandbox --json-api-port`). For the executor's needs — allocate
// parties, read the ACS, submit-and-wait — this is a handful of endpoints,
// which keeps the tool dependency-free (no @grpc/grpc-js, no protobuf).
// The gRPC API stays an option later behind the same LedgerApi interface.
//
// Endpoint shapes verified against a live sandbox (SDK 3.4.11); if a field
// name drifts in a future SDK, the probe script in test/ is the fast check.

import { noAuth, type TokenProvider } from "./auth.ts";

export interface ActiveContract {
  contractId: string;
  templateId: string;
  /** The create argument as Daml-JSON (numerics are strings). */
  payload: Record<string, unknown>;
}

export type LedgerCommand =
  | { CreateCommand: { templateId: string; createArguments: unknown } }
  | {
      ExerciseCommand: {
        templateId: string;
        contractId: string;
        choice: string;
        choiceArgument: unknown;
      };
    };

export type SubmitResult =
  | { ok: true; updateId: string }
  | { ok: false; error: string };

/** A contract created by a transaction, in node order. */
export interface CreatedContract {
  contractId: string;
  templateId: string;
}

/** What a setup step gets back: the contracts the transaction created and the
 * root choice's return value. Factory choices (daml-finance, the Token
 * Standard) hand back the new contract id that way, and a setup program has
 * to capture it to use it in the next step. */
export type SubmitTreeResult =
  | { ok: true; updateId: string; created: CreatedContract[]; exerciseResult: unknown }
  | { ok: false; error: string };

/** What the executor needs from a ledger — implemented by LedgerClient and
 * by the in-memory fake in tests. */
export interface LedgerApi {
  allocateParty(hint: string): Promise<string>;
  /** Live contracts of one template — or, with kind "interface", of every
   * template implementing one interface — visible to `parties`, sorted by
   * contractId so an index is stable within a run. */
  activeContracts(
    parties: string[],
    templateId: string,
    kind?: "template" | "interface",
  ): Promise<ActiveContract[]>;
  submitAndWait(req: SubmitRequest): Promise<SubmitResult>;
  /** Submit and read the resulting transaction tree. Used by the setup phase
   * (never on the measured path, where the extra payload would be overhead). */
  submitAndWaitForTree(req: SubmitRequest): Promise<SubmitTreeResult>;

  // ---- [S4] optional instrumentation capabilities -------------------------
  // Optional so a plain ledger (or a test fake) still satisfies the interface;
  // the runner degrades gracefully and simply reports less.

  /** Current ledger end offset — the write path's high-water mark. */
  ledgerEnd?(): Promise<number>;
  /** The synchronizer this participant is connected to, if it reports one. */
  connectedSynchronizerId?(): Promise<string | undefined>;
  /** Fetch what is needed to DISCLOSE a contract to submissions that cannot
   * see it (its template, and the signed created-event blob). */
  disclosureFor?(contractId: string, readAs: string[]): Promise<DisclosedContract | undefined>;
  /** Grant the authenticated user actAs/readAs rights over parties.
   *
   * Canton 3.x takes authorisation from participant USER MANAGEMENT rather
   * than from the token, so a token alone does not let you submit for a party
   * that was just allocated — the user needs rights over it. */
  grantRights?(userId: string, parties: string[]): Promise<void>;
  /** CIP-0104 traffic cost estimate for a command, without submitting it. */
  estimateTrafficCost?(req: {
    command: LedgerCommand;
    actAs: string[];
    synchronizerId: string;
  }): Promise<TrafficCost | undefined>;
}

/** A CIP-0104 traffic cost estimate, in traffic units. */
export interface TrafficCost {
  confirmationRequest: number;
  confirmationResponse: number;
  total: number;
}

export interface SubmitRequest {
  commands: LedgerCommand[];
  commandId: string;
  actAs: string[];
  /** Extra read authority — parties whose contracts must be visible without
   * being submitters. */
  readAs?: string[];
  /** [S2/disclosure] Contracts supplied WITH the submission, so the submitting
   * participant can use them without the submitter being a stakeholder. This
   * is how a Token-Standard wallet reaches a registry's factory: the registry
   * publishes the factory's created-event blob, and clients attach it. Without
   * it the only alternative is co-submitting as a stakeholder, which is not
   * what a real client does. */
  disclosedContracts?: DisclosedContract[];
}

/** A contract disclosed to a submission. `createdEventBlob` is the opaque,
 * signed payload the participant needs to accept a contract it cannot see. */
export interface DisclosedContract {
  templateId: string;
  contractId: string;
  createdEventBlob: string;
  synchronizerId?: string;
}

export class HttpJsonLedgerError extends Error {
  readonly path: string;
  readonly status: number;
  readonly body: string;
  constructor(path: string, status: number, body: string) {
    super(`${path} -> HTTP ${status}: ${body.slice(0, 400)}`);
    this.path = path;
    this.status = status;
    this.body = body;
  }
}

/** Unwrap a fetch/undici error to something a report can name. Node nests the
 * useful part (ECONNRESET, ECONNREFUSED, UND_ERR_*) in `cause`. */
export function transportCause(e: unknown): string {
  const err = e as { message?: string; cause?: { code?: string; message?: string } };
  const code = err?.cause?.code;
  const inner = err?.cause?.message;
  const outer = err?.message ?? String(e);
  if (code) return `${code} (${outer})`;
  return inner ? `${outer}: ${inner}` : outer;
}

/** Pull the human-meaningful message out of a JsCantonError body, falling
 * back to the raw text. */
export function cantonErrorCause(body: string): string {
  try {
    const j = JSON.parse(body) as { cause?: string; code?: string };
    if (j.cause) return j.code ? `${j.code}: ${j.cause}` : j.cause;
  } catch {
    /* not JSON — fall through */
  }
  return body.slice(0, 400);
}

export class LedgerClient implements LedgerApi {
  private readonly base: string;
  private readonly userId: string;
  private readonly auth: TokenProvider;
  constructor(base: string, userId = "ledger-api-user", auth: TokenProvider = noAuth) {
    this.base = base;
    this.userId = userId;
    this.auth = auth;
  }

  private async req(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    // Consulted per request, so a token refreshed mid-run is picked up.
    const token = await this.auth.get();
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(this.base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new HttpJsonLedgerError(path, res.status, text);
    return text ? JSON.parse(text) : null;
  }

  async ledgerEnd(): Promise<number> {
    const r = (await this.req("GET", "/v2/state/ledger-end")) as { offset: number };
    return r.offset;
  }

  async allocateParty(hint: string): Promise<string> {
    const r = (await this.req("POST", "/v2/parties", {
      partyIdHint: hint,
      identityProviderId: "",
    })) as { partyDetails: { party: string } };
    return r.partyDetails.party;
  }

  async activeContracts(
    parties: string[],
    templateId: string,
    kind: "template" | "interface" = "template",
  ): Promise<ActiveContract[]> {
    const activeAtOffset = await this.ledgerEnd();
    const identifierFilter =
      kind === "interface"
        ? {
            InterfaceFilter: {
              value: {
                interfaceId: templateId,
                // The view is the payload fallback: for standard interfaces
                // (Holding) it carries the owner an { ownerOf } arg needs.
                includeInterfaceView: true,
                includeCreatedEventBlob: false,
              },
            },
          }
        : { TemplateFilter: { value: { templateId, includeCreatedEventBlob: false } } };
    const filters = { cumulative: [{ identifierFilter }] };
    const r = (await this.req("POST", "/v2/state/active-contracts", {
      filter: { filtersByParty: Object.fromEntries(parties.map((p) => [p, filters])) },
      verbose: true,
      activeAtOffset,
    })) as Array<{
      contractEntry?: {
        JsActiveContract?: {
          createdEvent?: {
            contractId: string;
            templateId: string;
            createArgument?: Record<string, unknown>;
            interfaceViews?: Array<{ viewValue?: Record<string, unknown> }>;
          };
        };
      };
    }>;
    const out: ActiveContract[] = [];
    for (const entry of r) {
      const ev = entry.contractEntry?.JsActiveContract?.createdEvent;
      if (ev)
        out.push({
          contractId: ev.contractId,
          templateId: ev.templateId,
          // Interface-filtered events may omit the create argument; the
          // interface view is the fallback.
          payload: ev.createArgument ?? ev.interfaceViews?.[0]?.viewValue ?? {},
        });
    }
    out.sort((a, b) => (a.contractId < b.contractId ? -1 : 1));
    return out;
  }

  private body(req: SubmitRequest): Record<string, unknown> {
    return {
      commands: req.commands,
      commandId: req.commandId,
      actAs: req.actAs,
      readAs: req.readAs ?? [],
      userId: this.userId,
      disclosedContracts: req.disclosedContracts ?? [],
    };
  }

  async grantRights(userId: string, parties: string[]): Promise<void> {
    if (parties.length === 0) return;
    await this.req("POST", `/v2/users/${encodeURIComponent(userId)}/rights`, {
      userId,
      // The decoder is strict: identityProviderId must be present even when
      // empty (the default provider).
      identityProviderId: "",
      rights: parties.flatMap((party) => [
        { kind: { CanActAs: { value: { party } } } },
        { kind: { CanReadAs: { value: { party } } } },
      ]),
    });
  }

  /** Read a contract's created event WITH its blob, so it can be disclosed. */
  async disclosureFor(contractId: string, readAs: string[]): Promise<DisclosedContract | undefined> {
    try {
      // `eventFormat` is mandatory; `requestingParties` alone is rejected.
      const r = (await this.req("POST", "/v2/events/events-by-contract-id", {
        contractId,
        eventFormat: {
          filtersByParty: Object.fromEntries(
            readAs.map((p) => [
              p,
              {
                cumulative: [
                  { identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: true } } } },
                ],
              },
            ]),
          ),
          verbose: false,
        },
      })) as {
        created?: {
          createdEvent?: { templateId?: string; contractId?: string; createdEventBlob?: string };
          synchronizerId?: string;
        };
      };
      const ev = r.created?.createdEvent;
      if (!ev?.createdEventBlob) return undefined;
      return {
        templateId: ev.templateId ?? "",
        contractId: ev.contractId ?? contractId,
        createdEventBlob: ev.createdEventBlob,
        synchronizerId: r.created?.synchronizerId,
      };
    } catch {
      return undefined;
    }
  }

  async submitAndWait(req: SubmitRequest): Promise<SubmitResult> {
    try {
      const r = (await this.req(
        "POST",
        "/v2/commands/submit-and-wait",
        this.body(req),
      )) as { updateId: string };
      return { ok: true, updateId: r.updateId };
    } catch (e) {
      // Command rejections come back as HTTP errors with a JsCantonError
      // body — those are load-test DATA (contention, rejects), not client
      // failures.
      if (e instanceof HttpJsonLedgerError)
        return { ok: false, error: cantonErrorCause(e.body) };
      // Transport failures (`fetch failed`: connection refused, reset, socket
      // exhaustion) are data too. Found by the stress mode itself: at ~400
      // ops/s offered, sockets gave out and the thrown error aborted the whole
      // run, discarding every sample collected up to that point — losing
      // exactly the observation the test existed to make. A load tool must
      // RECORD the breaking point, not die at it.
      return { ok: false, error: `TRANSPORT_FAILURE: ${transportCause(e)}` };
    }
  }

  async connectedSynchronizerId(): Promise<string | undefined> {
    const r = (await this.req("GET", "/v2/state/connected-synchronizers")) as {
      connectedSynchronizers?: Array<{ synchronizerId?: string }>;
    };
    return r.connectedSynchronizers?.[0]?.synchronizerId;
  }

  /** [S4] Ask the participant what a command WOULD cost in traffic, without
   * submitting it (`interactive-submission/prepare` interprets the command and
   * returns a CIP-0104 cost estimate). Done out-of-band, before the measured
   * window, so instrumentation never perturbs the numbers it is measuring.
   *
   * Note: the JSON decoder is strict — `packageIdSelectionPreference` and
   * `estimateTrafficCost.expectedSignatures` must be present even though the
   * spec marks them optional. A synchronizer without traffic control simply
   * returns zeros (see `TrafficReport.unmetered`). */
  async estimateTrafficCost(req: {
    command: LedgerCommand;
    actAs: string[];
    synchronizerId: string;
  }): Promise<TrafficCost | undefined> {
    try {
      const r = (await this.req("POST", "/v2/interactive-submission/prepare", {
        userId: this.userId,
        commandId: `cs-cost-${Math.random().toString(36).slice(2, 10)}`,
        synchronizerId: req.synchronizerId,
        verboseHashing: false,
        actAs: req.actAs,
        readAs: [],
        commands: [req.command],
        packageIdSelectionPreference: [],
        estimateTrafficCost: { disabled: false, expectedSignatures: [] },
      })) as {
        costEstimation?: {
          confirmationRequestTrafficCostEstimation?: number;
          confirmationResponseTrafficCostEstimation?: number;
          totalTrafficCostEstimation?: number;
        };
      };
      const c = r.costEstimation;
      if (!c) return undefined;
      return {
        confirmationRequest: c.confirmationRequestTrafficCostEstimation ?? 0,
        confirmationResponse: c.confirmationResponseTrafficCostEstimation ?? 0,
        total: c.totalTrafficCostEstimation ?? 0,
      };
    } catch {
      // Cost estimation is a bonus signal: never fail a load run over it.
      return undefined;
    }
  }

  async submitAndWaitForTree(req: SubmitRequest): Promise<SubmitTreeResult> {
    try {
      const r = (await this.req(
        "POST",
        "/v2/commands/submit-and-wait-for-transaction-tree",
        this.body(req),
      )) as { transactionTree?: JsTransactionTree };
      return parseTransactionTree(r.transactionTree);
    } catch (e) {
      if (e instanceof HttpJsonLedgerError)
        return { ok: false, error: cantonErrorCause(e.body) };
      // Setup still fails loudly — runSetup turns a not-ok result into a
      // SetupError naming the step — but with a readable cause instead of a
      // raw undici stack.
      return { ok: false, error: `TRANSPORT_FAILURE: ${transportCause(e)}` };
    }
  }
}

// Shape verified against a live sandbox (SDK 3.4.11): `eventsById` is a map
// from node id (a stringified integer) to a one-key wrapper — CreatedTreeEvent
// or ExercisedTreeEvent — each holding the event under `value`.
interface JsTreeEvent {
  CreatedTreeEvent?: { value?: { contractId?: string; templateId?: string } };
  ExercisedTreeEvent?: { value?: { exerciseResult?: unknown } };
}
interface JsTransactionTree {
  updateId?: string;
  eventsById?: Record<string, JsTreeEvent>;
}

/** Pull the created contracts (in node order) and the root exercise result out
 * of a transaction tree. Exported for tests — no network involved. */
export function parseTransactionTree(tree: JsTransactionTree | undefined): SubmitTreeResult {
  if (!tree) return { ok: false, error: "no transactionTree in response" };
  const nodeIds = Object.keys(tree.eventsById ?? {}).sort((a, b) => Number(a) - Number(b));
  const created: CreatedContract[] = [];
  let exerciseResult: unknown = undefined;
  for (const id of nodeIds) {
    const ev = tree.eventsById![id];
    const c = ev.CreatedTreeEvent?.value;
    if (c?.contractId) created.push({ contractId: c.contractId, templateId: c.templateId ?? "" });
    // The ROOT exercise (lowest node id) is the command's own choice; deeper
    // nodes are its consequences, whose results are not what we bind.
    if (ev.ExercisedTreeEvent && exerciseResult === undefined)
      exerciseResult = ev.ExercisedTreeEvent.value?.exerciseResult;
  }
  return { ok: true, updateId: tree.updateId ?? "", created, exerciseResult };
}
