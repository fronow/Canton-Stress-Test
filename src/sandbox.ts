// Sandbox lifecycle: spawn `daml sandbox`, wait until it is actually ready,
// tear it down reliably — so `daml-fuzz run --sandbox <dar>` works from a
// cold start with no terminal juggling.
//
// Readiness signal: the sandbox writes its port files only once the
// participant is up and the DAR upload has succeeded, so polling for BOTH
// files is the same "Canton sandbox is ready" the human waits for.
//
// Environment facts baked in (cost real debugging time — see README):
//   * `daml` is a .cmd shim on Windows: spawn a single pre-quoted command
//     string with shell:true, never the bare name.
//   * Oracle JDK breaks Canton (unsigned BouncyCastle). `javaHome` prepends
//     an OpenJDK bin to the child's PATH without touching this process.
//   * Killing the shell wrapper does not kill the JVM underneath it — on
//     Windows the tree must go down via `taskkill /T`.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

export interface SandboxOptions {
  dar: string;
  ledgerPort?: number; // default 6865
  jsonPort?: number; // default 7575
  /** OpenJDK home whose bin is prepended to the child's PATH. */
  javaHome?: string;
  damlCmd?: string; // default "daml"
  timeoutMs?: number; // default 180_000
  onLog?: (line: string) => void;
}

export interface SandboxHandle {
  apiUrl: string;
  stop(): Promise<void>;
}

/** The spawn recipe, kept pure so tests can check quoting/env handling. */
export function sandboxCommand(opts: SandboxOptions, portDir: string): {
  command: string;
  args: string[] | null; // null → single command string via shell (win32)
  env: NodeJS.ProcessEnv;
} {
  const damlCmd = opts.damlCmd ?? "daml";
  const args = [
    "sandbox",
    "--dar",
    opts.dar,
    "--port",
    String(opts.ledgerPort ?? 6865),
    "--json-api-port",
    String(opts.jsonPort ?? 7575),
    "--port-file",
    join(portDir, "ledger.port"),
    "--json-api-port-file",
    join(portDir, "json.port"),
  ];
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (opts.javaHome) {
    // After spreading, env is a PLAIN object: on Windows the key is "Path"
    // and a blind env.PATH= would create a second, JDK-only variable that
    // shadows the real one in the child (→ 'daml' is not recognized).
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    env[pathKey] = join(opts.javaHome, "bin") + delimiter + (env[pathKey] ?? "");
  }
  if (process.platform === "win32") {
    const quote = (s: string) => (/\s/.test(s) ? `"${s}"` : s);
    return { command: [damlCmd, ...args].map(quote).join(" "), args: null, env };
  }
  return { command: damlCmd, args, env };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startSandbox(opts: SandboxOptions): Promise<SandboxHandle> {
  const portDir = mkdtempSync(join(tmpdir(), "daml-fuzz-sandbox-"));
  const jsonPortFile = join(portDir, "json.port");
  const ledgerPortFile = join(portDir, "ledger.port");
  const { command, args, env } = sandboxCommand(opts, portDir);

  const child: ChildProcess =
    args === null
      ? spawn(command, { shell: true, env, stdio: ["ignore", "pipe", "pipe"] })
      : spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });

  let output = "";
  const capture = (chunk: Buffer) => {
    const text = chunk.toString();
    output = (output + text).slice(-8192);
    if (opts.onLog) for (const l of text.split(/\r?\n/)) if (l.trim()) opts.onLog(l);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);

  let exited = false;
  child.on("exit", () => {
    exited = true;
  });

  const stop = async (): Promise<void> => {
    if (exited || child.pid === undefined) return;
    const gone = new Promise<void>((r) => child.once("exit", () => r()));
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { shell: false });
    } else {
      child.kill("SIGTERM");
    }
    await Promise.race([gone, sleep(10_000)]);
    rmSync(portDir, { recursive: true, force: true });
  };

  const deadline = Date.now() + (opts.timeoutMs ?? 180_000);
  while (!(existsSync(jsonPortFile) && existsSync(ledgerPortFile))) {
    if (exited)
      throw new Error(`sandbox exited before becoming ready:\n${output.slice(-2000)}`);
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`sandbox not ready after ${opts.timeoutMs ?? 180_000}ms:\n${output.slice(-2000)}`);
    }
    await sleep(500);
  }

  const jsonPort = Number(readFileSync(jsonPortFile, "utf8").trim());
  return { apiUrl: `http://localhost:${jsonPort}`, stop };
}
