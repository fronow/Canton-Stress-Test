// Finding a JDK that Canton will actually run on, without asking the user.
//
// `--java-home` was effectively mandatory, which is a poor thing to require of
// someone trying a tool for the first time: it is a flag you can only fill in
// if you already know the answer. Worse, omitting it did not fail cleanly — the
// sandbox fell through to whatever `java` was on PATH, and on a machine with an
// Oracle build that means Canton dies inside BouncyCastle with an error that
// says nothing about JDKs.
//
// So this looks for one, in the order a person would: what you told me, what
// your environment says, what is installed in the usual places, then PATH. And
// when it cannot find a usable one it says which JDKs it DID find and why they
// were rejected, because "no JDK found" on a machine with three of them is a
// worse message than no message.
//
// THE ORACLE PROBLEM, since it is the whole reason this is not one line:
// Canton needs BouncyCastle, and Oracle's JDK ships it unsigned, so the JVM
// refuses to load it. Any other distribution — Temurin, Zulu, Corretto,
// Microsoft, Liberica, the OpenJDK builds Linux packages — is fine.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface JdkInfo {
  /** JAVA_HOME-style directory: the one whose `bin` goes on PATH. */
  home: string;
  /** Major version, e.g. 21. */
  major: number;
  /** Vendor string as reported, for messages. */
  vendor: string;
  /** False for Oracle builds, which Canton cannot use. */
  usable: boolean;
  /** Why it was rejected, when it was. */
  reason?: string;
  /** How it was found, so the choice can be explained. */
  via: "flag" | "JAVA_HOME" | "installed" | "PATH";
}

/** Canton 3.x will not start on anything older. */
const MIN_MAJOR = 11;

const exe = (home: string): string =>
  join(home, "bin", process.platform === "win32" ? "java.exe" : "java");

/**
 * Ask a JDK what it is. Returns undefined when the path is not a JDK at all.
 *
 * `java -version` writes to STDERR, which is why the output is read from there
 * rather than stdout — a detail that silently returns empty if missed.
 */
/**
 * Decide what a `java -version` banner describes. Pure, so the awkward cases
 * can be tested without installing four JDKs.
 */
export function classify(
  banner: string,
  home: string,
  via: JdkInfo["via"],
): JdkInfo | undefined {
  // `java version "21.0.11"` or `openjdk version "17.0.9"`. Java 8 and earlier
  // use the legacy `1.8.0_341` scheme, where the major version is the SECOND
  // component — read naively that reports "Java 1" and rejects it for the wrong
  // reason.
  const v = /version "(\d+)(?:\.(\d+))?/.exec(banner);
  if (!v) return undefined;
  const major = Number(v[1]) === 1 && v[2] !== undefined ? Number(v[2]) : Number(v[1]);

  // Oracle's banner says "Java(TM) SE Runtime Environment"; every other
  // distribution says OpenJDK somewhere, including Temurin and Corretto whose
  // vendor lines also mention their own name.
  const isOracle =
    /Java\(TM\) SE Runtime Environment|Oracle/i.test(banner) && !/OpenJDK/i.test(banner);

  if (isOracle)
    return {
      home,
      major,
      vendor: "Oracle",
      usable: false,
      via,
      reason: "Oracle builds ship BouncyCastle unsigned, which Canton cannot load",
    };
  if (major < MIN_MAJOR)
    return {
      home,
      major,
      vendor: "OpenJDK",
      usable: false,
      via,
      reason: `Java ${major} is too old; Canton needs ${MIN_MAJOR} or newer`,
    };
  return { home, major, vendor: "OpenJDK", usable: true, via };
}

export function probe(home: string, via: JdkInfo["via"]): JdkInfo | undefined {
  const bin = exe(home);
  if (!existsSync(bin)) return undefined;
  // `java -version` writes to STDERR, not stdout — reading only stdout returns
  // an empty string and silently finds nothing, which is why spawnSync is used
  // here rather than execFileSync.
  const r = spawnSync(bin, ["-version"], { encoding: "utf8" });
  const out = `${r.stderr ?? ""}${r.stdout ?? ""}`;
  if (!out) return undefined;
  return classify(out, home, via);
}

/** Directories that commonly hold JDK installations, per platform. */
function searchRoots(): string[] {
  const roots: string[] = [];
  if (process.platform === "win32") {
    for (const base of ["C:\\Program Files", "C:\\Program Files (x86)"])
      for (const vendor of ["Eclipse Adoptium", "Java", "Microsoft", "Zulu", "Amazon Corretto", "BellSoft"])
        roots.push(join(base, vendor));
    roots.push(join(homedir(), "AppData", "Local", "Programs", "Eclipse Adoptium"));
    // Windows installers frequently leave an Oracle build on PATH, so a hand
    // unpacked OpenJDK next to the workspace is a common arrangement. Looking
    // one level up from the working directory finds it without a flag.
    roots.push(join(process.cwd(), "tools"), join(process.cwd(), "..", "tools"));
  } else if (process.platform === "darwin") {
    roots.push("/Library/Java/JavaVirtualMachines");
    roots.push(join(homedir(), "Library", "Java", "JavaVirtualMachines"));
  } else {
    roots.push("/usr/lib/jvm", "/usr/java", "/opt/java");
  }
  return roots;
}

/** JDK homes found under the usual install locations. */
function installed(): string[] {
  const found: string[] = [];
  for (const root of searchRoots()) {
    if (!existsSync(root)) continue;
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const e of entries) {
      const dir = join(root, e);
      // macOS nests the home one level down inside the bundle.
      for (const candidate of [dir, join(dir, "Contents", "Home")])
        if (existsSync(exe(candidate))) found.push(candidate);
    }
  }
  return found;
}

export interface JdkResolution {
  /** The JDK to use, when one was usable. */
  chosen?: JdkInfo;
  /** Everything found, usable or not — for the message when nothing works. */
  considered: JdkInfo[];
}

/**
 * Find a JDK Canton can run on.
 *
 * Order: the explicit flag, then JAVA_HOME, then installed JDKs, then PATH.
 * Newer usable versions win among installed candidates, so a machine with both
 * an old and a new JDK does the right thing without being told.
 */
export function resolveJdk(explicit?: string): JdkResolution {
  const considered: JdkInfo[] = [];
  const add = (home: string | undefined, via: JdkInfo["via"]) => {
    if (!home) return;
    if (considered.some((c) => c.home === home)) return;
    const info = probe(home, via);
    if (info) considered.push(info);
  };

  // An explicit flag is obeyed even if it looks wrong: the user may know
  // something this does not. It is still probed so the reason can be reported.
  add(explicit, "flag");
  const fromFlag = considered.find((c) => c.via === "flag");
  if (fromFlag) return { chosen: fromFlag, considered };

  add(process.env.JAVA_HOME, "JAVA_HOME");
  for (const home of installed()) add(home, "installed");

  // `java` on PATH last: it is the least specific signal, and on Windows it is
  // frequently an Oracle build placed there by an installer.
  const onPath = pathJavaHome();
  add(onPath, "PATH");

  const usable = considered.filter((c) => c.usable).sort((a, b) => b.major - a.major);
  return { chosen: usable[0], considered };
}

/** The JAVA_HOME implied by whichever `java` is on PATH. */
function pathJavaHome(): string | undefined {
  try {
    const out = execFileSync(
      process.platform === "win32" ? "where" : "which",
      ["java"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const first = out.split(/\r?\n/).find((l) => l.trim() !== "");
    if (!first) return undefined;
    // <home>/bin/java -> <home>
    return join(first.trim(), "..", "..");
  } catch {
    return undefined;
  }
}

/** What to print when no usable JDK was found: what was seen, and what to do. */
export function explainNoJdk(considered: JdkInfo[]): string {
  const lines = ["no JDK that Canton can run on was found."];
  if (considered.length > 0) {
    lines.push("", "Considered:");
    for (const c of considered)
      lines.push(`  ${c.home}  (Java ${c.major}, ${c.vendor}, via ${c.via})` + (c.reason ? `\n    rejected: ${c.reason}` : ""));
  }
  lines.push(
    "",
    "Canton needs a non-Oracle JDK 11 or newer — Temurin, Zulu, Corretto and",
    "Microsoft builds all work. Install one, or point at an existing one with:",
    "  --java-home <path>    (or set JAVA_HOME)",
  );
  return lines.join("\n");
}
