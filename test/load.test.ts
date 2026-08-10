import assert from "node:assert/strict";
import { test } from "node:test";
import { runLoad, resolvePayload } from "../src/load.ts";
import type {
  ActiveContract,
  LedgerApi,
  LedgerCommand,
  SubmitRequest,
  SubmitResult,
  SubmitTreeResult,
} from "../src/ledger.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fake ledger that accepts everything, tracks peak in-flight submissions,
 * and remembers what it was asked to do. */
class FakeLedger implements LedgerApi {
  allocated: string[] = [];
  submissions: Array<{ commands: LedgerCommand[]; commandId: string; actAs: string[] }> = [];
  inFlight = 0;
  peakInFlight = 0;
  created = 0;

  async allocateParty(hint: string): Promise<string> {
    this.allocated.push(hint);
    return `${hint}::fake`;
  }
  async activeContracts(): Promise<ActiveContract[]> {
    // Report whatever the setup phase created, as distinct contracts.
    return Array.from({ length: this.created }, (_, i) => ({
      contractId: `c${i}`,
      templateId: "pkg:M:T",
      payload: {},
    }));
  }
  async submitAndWait(req: SubmitRequest): Promise<SubmitResult> {
    this.inFlight++;
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
    await sleep(2);
    this.inFlight--;
    this.submissions.push(req);
    if ("CreateCommand" in req.commands[0]) this.created++;
    return { ok: true, updateId: `u${this.submissions.length}` };
  }

  // Setup runs through the tree endpoint so a step can bind what it created.
  async submitAndWaitForTree(req: SubmitRequest): Promise<SubmitTreeResult> {
    this.submissions.push(req);
    const cmd = req.commands[0];
    const templateId =
      "CreateCommand" in cmd ? cmd.CreateCommand.templateId : cmd.ExerciseCommand.templateId;
    if ("CreateCommand" in cmd) this.created++;
    const contractId = `c${this.submissions.length}`;
    return { ok: true, updateId: `u${this.submissions.length}`, created: [{ contractId, templateId }], exerciseResult: contractId };
  }
}

const base = {
  templateId: "#pkg:M:T",
  transferChoice: "Transfer",
  transferNewOwnerField: "newOwner",
  amount: "100.0",
  runId: "t1",
  seed: 42,
};

test("create workload: drives all ops, all committed, parties allocated", async () => {
  const fake = new FakeLedger();
  const report = await runLoad(fake, { ...base, parties: 3, ops: 10, concurrency: 4, workload: "create" });
  assert.equal(report.summary.ops, 10);
  assert.equal(report.summary.committed, 10);
  assert.equal(report.summary.contention, 0);
  assert.equal(fake.allocated.length, 3);
  // Every op is a create command.
  const ops = fake.submissions.filter((s) => s.commandId.includes("-op-"));
  assert.equal(ops.length, 10);
  assert.ok(ops.every((s) => "CreateCommand" in s.commands[0]));
});

test("concurrency cap is respected (peak in-flight ≤ concurrency)", async () => {
  const fake = new FakeLedger();
  await runLoad(fake, { ...base, parties: 2, ops: 30, concurrency: 5, workload: "create" });
  assert.ok(fake.peakInFlight <= 5, `peak in-flight ${fake.peakInFlight} exceeded 5`);
  assert.ok(fake.peakInFlight >= 2, `expected real concurrency, saw ${fake.peakInFlight}`);
});

test("transfer workload: pre-mints a pool, then exercises the choice", async () => {
  const fake = new FakeLedger();
  const report = await runLoad(fake, { ...base, parties: 2, ops: 8, concurrency: 4, workload: "transfer" });
  assert.equal(report.summary.ops, 8);
  const setup = fake.submissions.filter((s) => s.commandId.includes("-setup-"));
  const ops = fake.submissions.filter((s) => s.commandId.includes("-op-"));
  assert.ok(setup.length >= 8, "a pool was pre-minted");
  assert.ok(setup.every((s) => "CreateCommand" in s.commands[0]));
  assert.equal(ops.length, 8);
  assert.ok(ops.every((s) => "ExerciseCommand" in s.commands[0]));
});

test("resolvePayload substitutes placeholders (nested), leaves literals", () => {
  const ctx = { issuer: "I", party: () => "R", parties: ["P0", "P1", "P2"], amount: "42.0" };
  const out = resolvePayload(
    {
      issuer: "$issuer",
      owner: "$party",
      admin: "$p1",
      amount: "$amount",
      label: "literal",
      nested: { holders: ["$p0", "$party"], count: 3 },
    },
    ctx,
  );
  assert.deepEqual(out, {
    issuer: "I",
    owner: "R",
    admin: "P1",
    amount: "42.0",
    label: "literal",
    nested: { holders: ["P0", "R"], count: 3 },
  });
});

test("--create-args shape is used for the create command", async () => {
  const fake = new FakeLedger();
  await runLoad(fake, {
    ...base,
    parties: 2,
    ops: 3,
    concurrency: 1,
    workload: "create",
    createArgs: { owner: "$party", issuer: "$issuer", note: "hello" },
  });
  const op = fake.submissions.find((s) => s.commandId.includes("-op-"))!;
  const args = (op.commands[0] as { CreateCommand: { createArguments: Record<string, unknown> } })
    .CreateCommand.createArguments;
  assert.equal(args.note, "hello");
  assert.equal(args.issuer, "cs-t1-p0::fake");
  assert.ok(String(args.owner).endsWith("::fake"));
});

test("contention is classified from ledger errors", async () => {
  const fake = new FakeLedger();
  // Reject every op with a contention error.
  fake.submitAndWait = async (req) => {
    fake.submissions.push(req);
    return { ok: false, error: "LOCAL_VERDICT_LOCKED: locked by a concurrent transaction" };
  };
  const report = await runLoad(fake, { ...base, parties: 2, ops: 6, concurrency: 3, workload: "create" });
  assert.equal(report.summary.committed, 0);
  assert.equal(report.summary.contention, 6);
  assert.equal(report.summary.contentionRate, 1);
});
