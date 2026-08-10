// INTEGRATION tests — these drive a REAL Canton ledger.
//
// The 100-odd tests in test/*.test.ts are hermetic: fake ledgers, no JVM, one
// second. They prove the logic. They cannot prove that the JSON Ledger API
// still has the shape we think it has — and that is precisely what breaks when
// an SDK is upgraded.
//
// Everything here was verified by hand at some point. Hand-verification does
// not survive a refactor, so it lives here instead.
//
// Run:  npm run test:integration
// Skipped unless CANTON_STRESS_IT=1, so `npm test` stays fast and offline.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { LedgerClient } from "../../src/ledger.ts";
import { prepareRun, runWorkload } from "../../src/load.ts";
import { startSandbox, type SandboxHandle } from "../../src/sandbox.ts";
import type { SetupStep, Workload } from "../../src/workload.ts";

const ENABLED = process.env.CANTON_STRESS_IT === "1";
const DAR =
  process.env.CANTON_STRESS_IT_DAR ??
  "examples/settlement-app/.daml/dist/canton-stress-settlement-0.1.0.dar";
const JAVA_HOME = process.env.CANTON_STRESS_IT_JAVA ?? process.env.JAVA_HOME;

const T = (e: string) => `#canton-stress-settlement:Settlement:${e}`;

describe("against a real Canton ledger", { skip: !ENABLED && "set CANTON_STRESS_IT=1 to run" }, () => {
  let sandbox: SandboxHandle;
  let api: LedgerClient;

  before(async () => {
    assert.ok(existsSync(DAR), `DAR not found: ${DAR} — build it with 'daml build'`);
    // One sandbox for the whole file: booting Canton costs ~40s, so a
    // sandbox per test would make the suite unusable and nobody would run it.
    sandbox = await startSandbox({ dar: DAR, javaHome: JAVA_HOME });
    api = new LedgerClient(sandbox.apiUrl);
  });

  after(async () => {
    await sandbox?.stop();
  });

  // ---- the API shapes we depend on --------------------------------------

  test("the transaction tree still carries created contracts and the exercise result", async () => {
    const custodian = await api.allocateParty("it-custodian");
    const create = await api.submitAndWaitForTree({
      commands: [{ CreateCommand: { templateId: T("AccountFactory"), createArguments: { custodian } } }],
      commandId: `it-tree-${Date.now()}`,
      actAs: [custodian],
    });
    assert.ok(create.ok, `create failed: ${!create.ok ? create.error : ""}`);
    assert.equal(create.created.length, 1);
    assert.match(create.created[0].templateId, /Settlement:AccountFactory/);

    // A factory choice returns the new contract id — the fact S2's binding
    // table is built on.
    const alice = await api.allocateParty("it-alice");
    const opened = await api.submitAndWaitForTree({
      commands: [
        {
          ExerciseCommand: {
            templateId: T("AccountFactory"),
            contractId: create.created[0].contractId,
            choice: "OpenAccount",
            choiceArgument: { owner: alice },
          },
        },
      ],
      commandId: `it-open-${Date.now()}`,
      actAs: [custodian],
    });
    assert.ok(opened.ok, `exercise failed: ${!opened.ok ? opened.error : ""}`);
    const account = opened.created.find((c) => c.templateId.includes("Settlement:Account"));
    assert.ok(account, "the choice must report the Account it created");
    assert.equal(opened.exerciseResult, account.contractId, "exerciseResult must be the new cid");
  });

  test("a rejected command comes back as data, not as a thrown error", async () => {
    const p = await api.allocateParty("it-reject");
    const res = await api.submitAndWait({
      commands: [
        // amount must be > 0: the template's `ensure` rejects this.
        { CreateCommand: { templateId: T("Holding"), createArguments: { custodian: p, owner: p, symbol: "X", amount: "0.0" } } },
      ],
      commandId: `it-reject-${Date.now()}`,
      actAs: [p],
    });
    assert.equal(res.ok, false);
    assert.ok((res as { error: string }).error.length > 0, "a rejection must carry a cause");
  });

  test("connected synchronizer is reported (used for traffic estimation)", async () => {
    const s = await api.connectedSynchronizerId();
    assert.ok(s && s.length > 0, "a participant must report its synchronizer");
  });

  // ---- the S2 setup program, end to end ---------------------------------

  test("a setup program chains factory -> accounts -> holdings and binds each", async () => {
    const workload: Workload = {
      parties: 3,
      roles: ["custodian", "issuer"],
      setup: [
        { id: "factory", actAs: ["$role:custodian"], op: { kind: "create", template: T("AccountFactory"), args: { custodian: "$role:custodian" } } },
        { id: "instrument", actAs: ["$role:issuer"], op: { kind: "create", template: T("Instrument"), args: { issuer: "$role:issuer", custodian: "$role:custodian", symbol: "USD" } } },
        { id: "accounts", count: 3, actAs: ["$role:custodian"], op: { kind: "exercise", template: T("AccountFactory"), contract: "$ref:factory", choice: "OpenAccount", args: { owner: "$pi" } } },
        { id: "holdings", count: 6, actAs: ["$role:custodian"], op: { kind: "exercise", template: T("Account"), contract: "$ref:accounts[$i]", choice: "Credit", args: { instrument: "$ref:instrument", amount: "100.0" } } },
      ],
      operations: [{ weight: 1, op: { kind: "create", template: T("Instrument"), args: { issuer: "$role:issuer", custodian: "$role:custodian", symbol: "X" } } }],
    };
    const prep = await prepareRun(api, workload, { amount: "1.0", seed: 1, runId: `it${Date.now().toString(36)}` });

    assert.equal(prep.bindings.factory.length, 1);
    assert.equal(prep.bindings.accounts.length, 3);
    assert.equal(prep.bindings.holdings.length, 6, "count repetitions must each bind");
    assert.equal(prep.setup.submitted, 11);
    // Every bound id must be a distinct real contract.
    assert.equal(new Set(prep.bindings.holdings).size, 6);
  });

  test("a measured run commits, and submits as the target contract's owner", async () => {
    const runId = `it${Date.now().toString(36)}`;
    const workload: Workload = {
      parties: 4,
      roles: ["custodian", "issuer"],
      setup: [
        { id: "factory", actAs: ["$role:custodian"], op: { kind: "create", template: T("AccountFactory"), args: { custodian: "$role:custodian" } } },
        { id: "instrument", actAs: ["$role:issuer"], op: { kind: "create", template: T("Instrument"), args: { issuer: "$role:issuer", custodian: "$role:custodian", symbol: "USD" } } },
        { id: "accounts", count: 4, actAs: ["$role:custodian"], op: { kind: "exercise", template: T("AccountFactory"), contract: "$ref:factory", choice: "OpenAccount", args: { owner: "$pi" } } },
        { id: "holdings", count: 20, actAs: ["$role:custodian"], op: { kind: "exercise", template: T("Account"), contract: "$ref:accounts[$i]", choice: "Credit", args: { instrument: "$ref:instrument", amount: "500.0" } } },
      ],
      operations: [
        {
          weight: 1,
          op: { kind: "exercise", template: T("Holding"), choice: "Transfer", actAsFrom: ["owner"], args: { newAccount: "$ref:accounts[*]" } },
          submit: { actAs: ["$role:custodian"] },
        },
      ],
    };
    const rep = await runWorkload(api, workload, { kind: "closed", ops: 12, warmup: 0, concurrency: 3 }, {
      amount: "1.0",
      seed: 7,
      runId,
    });

    assert.equal(rep.summary.ops, 12);
    assert.ok(rep.summary.committed > 0, "some transfers must commit against a real ledger");
    assert.equal(rep.summary.committed + rep.summary.contention + rep.summary.rejected, 12);
    assert.ok(rep.setup, "the report must record what state it measured against");
    // Instrumentation must survive a real run.
    assert.ok(rep.instrumentation);
    assert.ok(rep.instrumentation.byParty.length > 0);
  });

  // ---- explicit disclosure ----------------------------------------------

  test("EXPLICIT DISCLOSURE lets a party exercise a contract it cannot see", async () => {
    const runId = `it${Date.now().toString(36)}`;
    // Ticket is signed by the operator with NO observers, and Claim's
    // controller comes from the argument — so the claimer authorises the
    // choice but cannot see the contract. Without disclosure this must fail.
    const workload: Workload = {
      parties: 2,
      roles: ["operator"],
      setup: [
        {
          id: "ticket",
          disclose: true,
          actAs: ["$role:operator"],
          op: { kind: "create", template: T("Ticket"), args: { operator: "$role:operator", label: "it" } },
        },
      ],
      operations: [
        {
          weight: 1,
          op: { kind: "exercise", template: T("Ticket"), contract: "$ref:ticket", choice: "Claim", args: { claimer: "$p0" } },
          submit: { actAs: ["$p0"] },
        },
      ],
    };
    const rep = await runWorkload(api, workload, { kind: "closed", ops: 3, warmup: 0, concurrency: 1 }, {
      amount: "1.0",
      seed: 3,
      runId,
    });
    assert.equal(rep.summary.committed, 3, "the claimer must succeed via the disclosed contract");

    // And the control: the same thing without disclosure must NOT work.
    const undisclosed: Workload = {
      ...workload,
      setup: [{ ...(workload.setup[0] as SetupStep), disclose: false }],
    };
    const bad = await runWorkload(api, undisclosed, { kind: "closed", ops: 2, warmup: 0, concurrency: 1 }, {
      amount: "1.0",
      seed: 4,
      runId: `${runId}b`,
    });
    assert.equal(bad.summary.committed, 0, "without disclosure the claimer cannot see the contract");
  });

  test("disclosureFor returns a usable blob for a readable contract", async () => {
    const op = await api.allocateParty("it-op");
    const created = await api.submitAndWaitForTree({
      commands: [{ CreateCommand: { templateId: T("Ticket"), createArguments: { operator: op, label: "blob" } } }],
      commandId: `it-blob-${Date.now()}`,
      actAs: [op],
    });
    assert.ok(created.ok);
    const d = await api.disclosureFor(created.created[0].contractId, [op]);
    assert.ok(d, "a stakeholder must be able to read the disclosure blob");
    assert.ok(d.createdEventBlob.length > 0);
    assert.match(d.templateId, /Settlement:Ticket/);
    assert.ok(d.synchronizerId, "disclosure needs the synchronizer id");
  });
});
