import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ActiveContract,
  LedgerApi,
  SubmitRequest,
  SubmitResult,
  SubmitTreeResult,
} from "../src/ledger.ts";
import { prepareRun, runWorkload } from "../src/load.ts";
import type { Workload } from "../src/workload.ts";

/** One participant. Records what it was asked to do so routing can be
 * asserted exactly — the point being WHICH node received each submission. */
class FakeParticipant implements LedgerApi {
  readonly name: string;
  allocated: string[] = [];
  submissions: SubmitRequest[] = [];
  contracts: ActiveContract[] = [];
  constructor(name: string) {
    this.name = name;
  }
  async allocateParty(hint: string): Promise<string> {
    const p = `${hint}::${this.name}`;
    this.allocated.push(p);
    return p;
  }
  async activeContracts(): Promise<ActiveContract[]> {
    return this.contracts;
  }
  async submitAndWait(req: SubmitRequest): Promise<SubmitResult> {
    this.submissions.push(req);
    return { ok: true, updateId: "u" };
  }
  async submitAndWaitForTree(req: SubmitRequest): Promise<SubmitTreeResult> {
    this.submissions.push(req);
    const cmd = req.commands[0];
    const templateId =
      "CreateCommand" in cmd ? cmd.CreateCommand.templateId : cmd.ExerciseCommand.templateId;
    const contractId = `c${this.submissions.length}-${this.name}`;
    return { ok: true, updateId: "u", created: [{ contractId, templateId }], exerciseResult: contractId };
  }
}

const base = { amount: "10.0", seed: 1, runId: "t" };

test("round-robin placement hosts party i on participant i % n", async () => {
  const p1 = new FakeParticipant("p1");
  const p2 = new FakeParticipant("p2");
  const workload: Workload = {
    parties: 4,
    placement: "round-robin",
    roles: ["issuer", "custodian"],
    rolePlacement: { issuer: 0, custodian: 1 },
    setup: [],
    operations: [{ weight: 1, op: { kind: "create", template: "M:T", args: {} } }],
  };
  const prep = await prepareRun([p1, p2], workload, base);

  // Population alternates across the two nodes.
  assert.equal(p1.allocated.filter((p) => p.includes("-p")).length, 2); // p0, p2
  assert.equal(p2.allocated.filter((p) => p.includes("-p")).length, 2); // p1, p3
  // Roles land where they were pinned.
  assert.ok(prep.roles.issuer.endsWith("::p1"));
  assert.ok(prep.roles.custodian.endsWith("::p2"));
  // And the host map records it.
  assert.equal(prep.hostOf[prep.parties[0]], 0);
  assert.equal(prep.hostOf[prep.parties[1]], 1);
  assert.equal(prep.hostOf[prep.roles.custodian], 1);
});

test("default placement keeps everything on the first participant", async () => {
  const p1 = new FakeParticipant("p1");
  const p2 = new FakeParticipant("p2");
  const workload: Workload = {
    parties: 3,
    roles: ["issuer"],
    setup: [],
    operations: [{ weight: 1, op: { kind: "create", template: "M:T", args: {} } }],
  };
  const prep = await prepareRun([p1, p2], workload, base);
  assert.equal(p2.allocated.length, 0, "no party should be placed on the second node");
  assert.ok(Object.values(prep.hostOf).every((h) => h === 0));
});

test("a setup step is submitted to the node hosting its actAs party", async () => {
  const p1 = new FakeParticipant("p1");
  const p2 = new FakeParticipant("p2");
  const workload: Workload = {
    parties: 2,
    placement: "round-robin",
    roles: ["issuer"],
    rolePlacement: { issuer: 1 }, // pinned to the SECOND node
    setup: [
      { id: "offer", actAs: ["$role:issuer"], op: { kind: "create", template: "M:Offer", args: {} } },
    ],
    operations: [{ weight: 1, op: { kind: "create", template: "M:T", args: {} } }],
  };
  await prepareRun([p1, p2], workload, base);

  // The issuer lives on p2, so the create went there — not to the coordinator.
  assert.equal(p2.submissions.length, 1);
  assert.equal(p1.submissions.length, 0);
});

test("a measured op is routed to the participant hosting its submitter", async () => {
  // The regression this pins: ops were sent to a round-robin node while the
  // submitter is dictated by the contract (`actAsFrom`). Against a real
  // two-node network that rejected every operation whose counterparty lived
  // on the other participant — half the run.
  const p1 = new FakeParticipant("p1");
  const p2 = new FakeParticipant("p2");
  const workload: Workload = {
    parties: 2, // p0 -> node 0, p1 -> node 1
    placement: "round-robin",
    setup: [],
    operations: [
      {
        weight: 1,
        op: { kind: "exercise", template: "M:Offer", choice: "Accept", actAsFrom: ["to"], args: {} },
      },
    ],
  };
  const prep = await prepareRun([p1, p2], workload, base);
  const recipient = prep.parties[1]; // hosted on node 1
  // The offer is visible on BOTH nodes (both are stakeholders), so the pool
  // alone cannot decide where to submit — only the submitter can.
  const offer: ActiveContract = {
    contractId: "offer1",
    templateId: "M:Offer",
    payload: { to: recipient },
  };
  p1.contracts = [offer];
  p2.contracts = [offer];

  await runWorkload([p1, p2], workload, { kind: "closed", ops: 4, warmup: 0, concurrency: 1 }, base);

  const opsOn = (p: FakeParticipant) => p.submissions.filter((s) => s.commandId.includes("-op-"));
  assert.equal(opsOn(p1).length, 0, "nothing should be submitted to the node that cannot sign");
  assert.equal(opsOn(p2).length, 4);
  assert.ok(opsOn(p2).every((s) => s.actAs.includes(recipient)));
});

test("party choices stay local to the submitting participant", async () => {
  // "$party" must never pick a party the submitting node does not host,
  // because Canton refuses a submission for a party it does not host.
  const p1 = new FakeParticipant("p1");
  const p2 = new FakeParticipant("p2");
  const workload: Workload = {
    parties: 4,
    placement: "round-robin",
    setup: [],
    operations: [
      { weight: 1, op: { kind: "create", template: "M:T", args: { owner: "$party" } } },
    ],
  };
  const prep = await prepareRun([p1, p2], workload, base);
  await runWorkload([p1, p2], workload, { kind: "closed", ops: 8, warmup: 0, concurrency: 1 }, base);

  for (const [node, idx] of [
    [p1, 0],
    [p2, 1],
  ] as const) {
    for (const s of node.submissions.filter((x) => x.commandId.includes("-op-"))) {
      const args = (s.commands[0] as { CreateCommand: { createArguments: Record<string, unknown> } })
        .CreateCommand.createArguments;
      assert.equal(prep.hostOf[String(args.owner)], idx, `owner ${args.owner} not hosted on node ${idx}`);
      for (const a of s.actAs) assert.equal(prep.hostOf[a], idx);
    }
  }
  // Both nodes actually drove load.
  assert.ok(p1.submissions.length > 0 && p2.submissions.length > 0);
});
