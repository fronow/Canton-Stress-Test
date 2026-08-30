// Reading a DAR well enough to plan a load test from it, with no user input.
//
// The zero-configuration path — `canton-stress <dar>` — has to answer three
// questions before it can run anything: what is in this package, which of it is
// worth measuring, and how is it addressed on the ledger. A DAR answers all
// three itself, because it carries both its compiled dependencies and the Daml
// SOURCES they were built from.
//
// Template discovery reads those sources rather than the compiled Daml-LF. That
// is a deliberate trade: parsing LF would be exact but means implementing a
// protobuf schema that changes between LF versions, while the sources are
// stable text and already in the file. The cost is that this sees what the code
// SAYS, not what the compiler produced — acceptable here because everything it
// looks for (a template declaration, an interface instance) is a syntactic
// construct that cannot be produced any other way.
//
// Conformance to the Canton Network Token Standard is the specific thing worth
// detecting, and a registry declares it explicitly:
//
//     interface instance Holding for SimpleHolding where
//     interface instance TransferFactory for SimpleTokenRules where
//
// So "does this DAR implement CIP-0056, and under which templates" is read off
// a declaration the author had to write, not inferred from naming convention.

import { inflateRawSync } from "node:zlib";
import { readFileSync } from "node:fs";

/** One field of a template's `with` block. */
export interface DarField {
  name: string;
  /** The type as written, e.g. "Party", "[Text]", "InstrumentId". */
  type: string;
}

/** A choice declared on a template. */
export interface DarChoice {
  name: string;
  /** False for `nonconsuming` — a nonconsuming choice cannot conflict with
   * itself, which changes what a contention measurement means. */
  consuming: boolean;
  /** Return type as written, e.g. "ContractId Account" or "()". */
  returnType: string;
  /** The choice's own arguments, from its `with` block. */
  fields: DarField[];
  /** Field names listed as `controller`, when they are a plain list. Empty when
   * the controller is computed, which this does not try to evaluate. */
  controllers: string[];
}

/** One template found in a DAR, with the interfaces it declares instances of. */
export interface DarTemplate {
  /** Dotted module name, e.g. "SimpleToken.Holding". */
  module: string;
  name: string;
  /** Unqualified interface names, e.g. ["Holding"]. */
  interfaces: string[];
  /** How the Ledger API addresses it: "#<package>:<module>:<template>". */
  id: string;
  /** The template's payload fields, in declaration order. */
  fields: DarField[];
  /** Field names listed as `signatory`, when they are a plain list of field
   * names. Empty when the template computes its signatories, which this does
   * not try to evaluate. Determines who must submit a create. */
  signatories: string[];
  /** A string literal assigned to `id` inside an interface instance's view,
   * e.g. `instrumentId = InstrumentId with admin = issuer; id = "StdToken"`.
   * When a registry hard-codes its instrument this way, a transfer must name
   * that exact value, and it cannot be chosen freely. */
  instrumentIdLiteral?: string;
  /** Choices declared directly on the template (not via an interface). */
  choices: DarChoice[];
  /** Templates this one needs to exist first, because it holds a
   * `ContractId <T>` field. This is the dependency graph a setup program has to
   * respect, and the DAR states it — no domain knowledge required. */
  dependsOn: string[];
}

export interface DarInfo {
  /** Main package name and version, from the DAR's own directory prefix. */
  packageName: string;
  packageVersion: string;
  templates: DarTemplate[];
  /** Package names of the DALFs the DAR bundles, main package included. */
  dependencies: string[];
}

export class DarError extends Error {}

// --- minimal ZIP reader ----------------------------------------------------
// A DAR is a ZIP. Node ships deflate but no archive reader, and this project
// carries no runtime dependencies, so the central directory is walked by hand.
// Only what a DAR actually uses is supported: stored and deflated entries.

interface ZipEntry {
  name: string;
  data: () => Buffer;
}

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;

function readZip(buf: Buffer, what: string): ZipEntry[] {
  // The end-of-central-directory record sits at the end, after a comment of
  // unknown length, so it is found by scanning backwards for its signature.
  let eocd = -1;
  const lowest = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= lowest; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new DarError(`${what}: not a ZIP archive (no end-of-central-directory record)`);

  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  // ZIP64 marks the fields it has outgrown with all-ones. No DAR should be
  // anywhere near 4 GB or 65535 entries, so rather than half-implement ZIP64
  // this says exactly what it met and stops.
  if (cdOffset === 0xffffffff || count === 0xffff)
    throw new DarError(`${what}: ZIP64 archives are not supported`);

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CD_SIG)
      throw new DarError(`${what}: central directory entry ${i} is malformed`);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);

    entries.push({
      name,
      // Decompressed lazily: a DAR holds hundreds of entries and this only
      // ever reads the handful that are Daml sources.
      data: () => {
        // The local header repeats the name and extra fields, and its extra
        // field length may DIFFER from the central directory's — so the data
        // offset must be computed from the local header, never the central one.
        if (buf.readUInt32LE(localOffset) !== 0x04034b50)
          throw new DarError(`${what}: local header for "${name}" is malformed`);
        const lNameLen = buf.readUInt16LE(localOffset + 26);
        const lExtraLen = buf.readUInt16LE(localOffset + 28);
        const start = localOffset + 30 + lNameLen + lExtraLen;
        const raw = buf.subarray(start, start + compSize);
        if (method === 0) return Buffer.from(raw);
        if (method === 8) return inflateRawSync(raw);
        throw new DarError(`${what}: entry "${name}" uses unsupported compression method ${method}`);
      },
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// --- source scanning -------------------------------------------------------

/** `template Foo` at the start of a line — templates are always top level. */
const TEMPLATE_RE = /^template\s+([A-Z][A-Za-z0-9_']*)/;

/** `choice Name : ReturnType`, optionally prefixed by a consumption modifier.
 * Always indented, since choices live inside a template body. */
const CHOICE_RE =
  /^\s+(nonconsuming\s+|preconsuming\s+|postconsuming\s+)?choice\s+([A-Z][A-Za-z0-9_']*)\s*:\s*(.+?)\s*$/;

/** `controller a, b` as a plain list of names. */
const CONTROLLER_RE = /^\s+controller\s+([a-z][A-Za-z0-9_']*(?:\s*,\s*[a-z][A-Za-z0-9_']*)*)\s*$/;

/** The template a `ContractId T` field points at, however it is wrapped —
 * `ContractId T`, `Optional (ContractId T)`, `[ContractId T]`. Returns the
 * bare template name, or undefined when the field is not a contract reference. */
function contractIdTarget(type: string): string | undefined {
  const m = /\bContractId\s+\(?\s*([A-Za-z][A-Za-z0-9_'.]*)/.exec(type);
  if (!m) return undefined;
  const t = m[1];
  return t.slice(t.lastIndexOf(".") + 1);
}

/** `interface instance Iface for Tpl where`, the interface possibly qualified.
 * Always indented, since it lives inside a template body. */
const INSTANCE_RE =
  /^\s+interface\s+instance\s+([A-Za-z0-9_'.]+)\s+for\s+([A-Z][A-Za-z0-9_']*)\s*where/;

/** Strip a module qualifier: "Splice.Api.Token.HoldingV1.Holding" -> "Holding". */
const unqualify = (s: string): string => s.slice(s.lastIndexOf(".") + 1);

/** `field : Type`, or `a, b : Type` which Daml also allows. */
const FIELD_RE = /^([a-z][A-Za-z0-9_']*(?:\s*,\s*[a-z][A-Za-z0-9_']*)*)\s*:\s*(.+)$/;

/**
 * Read the `with` block that follows a template declaration.
 *
 * `lines[start]` is the `template X` line. Returns the fields and the index of
 * the line after the block, so the caller can keep scanning.
 */
function readFields(lines: string[], start: number): DarField[] {
  let i = start + 1;
  // Between the declaration and "with" there is nothing but blank lines.
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i >= lines.length) return [];

  const fields: DarField[] = [];
  const head = lines[i].trim();
  if (head === "with") {
    i++;
  } else if (head.startsWith("with ")) {
    // Daml also allows the first field on the same line as `with`, which is
    // common for single-argument choices: `with newOwner : Party`. Missing this
    // form produced choices with no arguments at all.
    const inline = FIELD_RE.exec(head.slice(5).replace(/--.*$/, "").trim());
    if (inline)
      for (const name of inline[1].split(",")) fields.push({ name: name.trim(), type: inline[2].trim() });
    i++;
  } else {
    return [];
  }
  for (; i < lines.length; i++) {
    const raw = lines[i];
    // "where" closes the block; a non-indented line means the template ended
    // without one, which the compiler would have rejected but this must not
    // hang on.
    // `where` closes a template's block; `controller` and `do` close a
    // choice's. None of them can appear as a field name, so this is safe for
    // both callers.
    if (/^(where|controller\b|do\b)/.test(raw.trim())) break;
    if (raw.trim() !== "" && !/^\s/.test(raw)) break;
    // Daml comments: "-- ^ field doc" lines and trailing comments alike.
    const line = raw.replace(/--.*$/, "").trim();
    if (line === "") continue;
    const m = FIELD_RE.exec(line);
    // A continuation of a multi-line type, or something unparsed. Attaching it
    // to the previous field is wrong more often than dropping it, and a field
    // this code cannot read is reported honestly by the planner rather than
    // guessed at here.
    if (!m) continue;
    const type = m[2].trim();
    for (const name of m[1].split(",")) fields.push({ name: name.trim(), type });
  }
  return fields;
}

/** Package name out of a DALF entry name, dropping the `-<64 hex>` content hash
 * and any version between it and the name. */
function dalfPackageName(file: string): string | undefined {
  const base = file.slice(file.lastIndexOf("/") + 1).replace(/\.dalf$/, "");
  const noHash = base.replace(/-[0-9a-f]{64}$/, "");
  if (noHash === base) return undefined;
  return noHash.replace(/-\d+(\.\d+)*$/, "");
}

/**
 * Read a DAR: its main package, the templates it declares, and which
 * interfaces each of them implements.
 *
 * Throws DarError with a message naming the file when it is not a readable DAR.
 */
export function inspectDar(path: string): DarInfo {
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch (e) {
    throw new DarError(`cannot read ${path}: ${(e as Error).message}`);
  }
  const entries = readZip(buf, path);

  // Everything in a DAR lives under one directory named
  // "<package>-<version>-<hash>", which is where the package name comes from.
  const root = entries.find((e) => /\/data\/.*\.conf$/.test(e.name))?.name.split("/")[0]
    ?? entries.map((e) => e.name.split("/")[0]).find((n) => /-[0-9a-f]{64}$/.test(n));
  if (!root) throw new DarError(`${path}: no package directory found — is this a DAR?`);
  const stem = root.replace(/-[0-9a-f]{64}$/, "");
  const vMatch = /^(.*)-(\d+(?:\.\d+)*)$/.exec(stem);
  const packageName = vMatch ? vMatch[1] : stem;
  const packageVersion = vMatch ? vMatch[2] : "";

  const dependencies = [
    ...new Set(
      entries
        .filter((e) => e.name.endsWith(".dalf"))
        .map((e) => dalfPackageName(e.name))
        .filter((n): n is string => !!n),
    ),
  ].sort();

  // Only the main package's own sources: a DAR also carries its dependencies'
  // sources, and templates from those are not this app's to measure.
  const sources = entries.filter(
    (e) => e.name.startsWith(root + "/") && e.name.endsWith(".daml"),
  );

  const templates: DarTemplate[] = [];
  const byName = new Map<string, DarTemplate>();
  for (const entry of sources) {
    const rel = entry.name.slice(root.length + 1);
    // "SimpleToken/Holding.daml" -> "SimpleToken.Holding"
    const module = rel.replace(/\.daml$/, "").split("/").join(".");
    let text: string;
    try {
      text = entry.data().toString("utf8");
    } catch (e) {
      throw new DarError(`${path}: cannot read source "${rel}": ${(e as Error).message}`);
    }
    const lines = text.split(/\r?\n/);
    // Everything indented after `template X` belongs to it, so `signatory` and
    // view literals are attributed by tracking which template is open.
    let open: DarTemplate | undefined;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const t = TEMPLATE_RE.exec(line);
      if (t) {
        const tpl: DarTemplate = {
          module,
          name: t[1],
          interfaces: [],
          id: `#${packageName}:${module}:${t[1]}`,
          fields: readFields(lines, i),
          signatories: [],
          choices: [],
          dependsOn: [],
        };
        templates.push(tpl);
        byName.set(t[1], tpl);
        open = tpl;
        continue;
      }
      // A new top-level declaration closes the previous template.
      if (line.trim() !== "" && !/^\s/.test(line)) open = undefined;

      const inst = INSTANCE_RE.exec(line);
      // An interface instance names its template explicitly, so it does not
      // matter which template body the line happened to sit in.
      if (inst) byName.get(inst[2])?.interfaces.push(unqualify(inst[1]));

      if (!open) continue;
      const sig = /^\s+signatory\s+(.+)$/.exec(line.replace(/--.*$/, ""));
      // Only a plain list of field names is usable. Anything computed is left
      // empty rather than half-parsed, and the planner says so.
      if (sig && open.signatories.length === 0) {
        const names = sig[1].trim();
        if (/^[a-z][A-Za-z0-9_']*(\s*,\s*[a-z][A-Za-z0-9_']*)*$/.test(names))
          open.signatories = names.split(",").map((s) => s.trim());
      }
      const lit = /\bid\s*=\s*"([^"]+)"/.exec(line);
      if (lit && open.instrumentIdLiteral === undefined) open.instrumentIdLiteral = lit[1];

      const ch = CHOICE_RE.exec(line);
      if (ch) {
        open.choices.push({
          name: ch[2],
          consuming: ch[1] === undefined,
          returnType: ch[3].trim(),
          fields: readFields(lines, i),
          controllers: [],
        });
        continue;
      }
      // A controller line belongs to the choice most recently opened on this
      // template. Templates also have a `controller` in the deprecated
      // `controller ... can` form, which this simply will not match.
      const ctl = CONTROLLER_RE.exec(line.replace(/--.*$/, ""));
      const lastChoice = open.choices[open.choices.length - 1];
      if (ctl && lastChoice && lastChoice.controllers.length === 0)
        lastChoice.controllers = ctl[1].split(",").map((s) => s.trim());
    }
  }

  // The dependency graph, read off the field types: a template holding a
  // `ContractId T` cannot be created until a T exists. Only references to
  // templates in THIS package are kept — a ContractId of an interface or of a
  // dependency's template is not something a setup program here can create.
  const known = new Set(templates.map((t) => t.name));
  for (const t of templates) {
    const deps = new Set<string>();
    for (const f of t.fields) {
      const target = contractIdTarget(f.type);
      // Self-reference is legal in Daml (a contract pointing at its own
      // predecessor) but is not a setup dependency, and would deadlock a sort.
      if (target && target !== t.name && known.has(target)) deps.add(target);
    }
    t.dependsOn = [...deps];
  }

  return { packageName, packageVersion, templates, dependencies };
}
