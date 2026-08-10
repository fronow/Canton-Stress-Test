// INTEGRATION test for AUTHENTICATION against a real, token-requiring Canton
// participant.
//
// This is the one that must not rot. The tool spent its whole life talking to
// an unauthenticated sandbox, where "auth works" was indistinguishable from
// "auth is not enforced". The control here — an unauthenticated call getting
// 401 — is what makes the positive result mean anything.
//
// Needs the Canton distribution bundled with the Daml SDK. Run:
//   $env:CANTON_STRESS_IT="1"
//   $env:CANTON_STRESS_IT_CANTON="$env:APPDATA\daml\sdk\3.4.11\canton\canton.jar"
//   npm run test:integration

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { join } from "node:path";
import { hs256Provider } from "../../src/auth.ts";
import { LedgerClient } from "../../src/ledger.ts";
import { runWorkload } from "../../src/load.ts";
import type { Workload } from "../../src/workload.ts";

const SECRET = "canton-stress-test-secret";
const API = "http://localhost:7011";
const NET = "examples/network";
const CANTON = process.env.CANTON_STRESS_IT_CANTON;
const JAVA = process.env.CANTON_STRESS_IT_JAVA ?? process.env.JAVA_HOME;
const T = (e: string) => `#canton-stress-settlement:Settlement:${e}`;

const enabled = process.env.CANTON_STRESS_IT === "1" && !!CANTON && existsSync(CANTON);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe(
  "authentication against a token-requiring participant",
  { skip: !enabled && "needs CANTON_STRESS_IT=1 and CANTON_STRESS_IT_CANTON=<canton.jar>" },
  () => {
    let child: ChildProcess;

    before(async () => {
      const java = JAVA ? join(JAVA, "bin", "java.exe") : "java";
      child = spawn(
        java,
        ["-jar", CANTON!, "daemon", "-c", "authenticated.conf", "--bootstrap", "bootstrap-auth.canton", "--no-tty"],
        { cwd: NET, stdio: ["ignore", "pipe", "pipe"], shell: false },
      );
      let out = "";
      child.stdout?.on("data", (c: Buffer) => (out += c.toString()));
      child.stderr?.on("data", (c: Buffer) => (out += c.toString()));

      const deadline = Date.now() + 300_000;
      while (!out.includes("AUTHNET READY")) {
        if (Date.now() > deadline) throw new Error(`authenticated node not ready:\n${out.slice(-1500)}`);
        if (child.exitCode !== null) throw new Error(`node exited early:\n${out.slice(-1500)}`);
        await sleep(2000);
      }
    });

    after(async () => {
      child?.kill();
      await sleep(1500);
      rmSync(join(NET, "log"), { recursive: true, force: true });
    });

    test("THE CONTROL: an unauthenticated call is rejected with 401", async () => {
      const res = await fetch(`${API}/v2/parties/participant-id`);
      assert.equal(res.status, 401, "if this is not 401 the participant is not enforcing auth, and the rest proves nothing");
    });

    test("a token with too long a lifetime is refused by Canton", async () => {
      // Measured behaviour, pinned: Canton rejects long-lived tokens outright,
      // which is why the provider mints short ones and refreshes.
      const { mintHs256 } = await import("../../src/auth.ts");
      const longLived = mintHs256(SECRET, { userId: "participant_admin", expiresInSeconds: 3600 });
      const res = await fetch(`${API}/v2/parties/participant-id`, {
        headers: { authorization: `Bearer ${longLived}` },
      });
      assert.notEqual(res.status, 200, "a one-hour token must not be accepted");
    });

    test("a short-lived scope-based token is accepted", async () => {
      const auth = hs256Provider(SECRET, { userId: "participant_admin" });
      const token = await auth.get();
      const res = await fetch(`${API}/v2/parties/participant-id`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200, await res.text());
    });

    test("a full authenticated run commits against the participant", async () => {
      const auth = hs256Provider(SECRET, { userId: "participant_admin" });
      // The submission's userId must match the token subject.
      const api = new LedgerClient(API, "participant_admin", auth);
      const workload: Workload = {
        parties: 2,
        roles: ["operator"],
        setup: [
          {
            id: "ticket",
            disclose: true,
            actAs: ["$role:operator"],
            op: { kind: "create", template: T("Ticket"), args: { operator: "$role:operator", label: "auth" } },
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
      const rep = await runWorkload(api, workload, { kind: "closed", ops: 5, warmup: 0, concurrency: 2 }, {
        amount: "1.0",
        seed: 11,
        runId: `auth${Date.now().toString(36)}`,
        // Canton 3.x authorises from user management, so parties allocated
        // mid-run need rights before they can submit.
        onPartiesAllocated: (ps) => api.grantRights("participant_admin", ps),
      });
      assert.equal(rep.summary.committed, 5, "authenticated run must commit every operation");
    });
  },
);
