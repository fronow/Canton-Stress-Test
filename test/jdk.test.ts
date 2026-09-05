import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, explainNoJdk, type JdkInfo } from "../src/jdk.ts";

// Real `java -version` banners. The point of testing against these rather than
// invented strings is that every awkward case here came off an actual JDK.

const ORACLE_17 = `java version "17" 2021-09-14 LTS
Java(TM) SE Runtime Environment (build 17+35-LTS-2724)
Java HotSpot(TM) 64-Bit Server VM (build 17+35-LTS-2724, mixed mode, sharing)`;

const ORACLE_8 = `java version "1.8.0_341"
Java(TM) SE Runtime Environment (build 1.8.0_341-b10)
Java HotSpot(TM) 64-Bit Server VM (build 25.341-b10, mixed mode)`;

const TEMURIN_21 = `openjdk version "21.0.11" 2026-04-16 LTS
OpenJDK Runtime Environment Temurin-21.0.11+9 (build 21.0.11+9-LTS)
OpenJDK 64-Bit Server VM Temurin-21.0.11+9 (build 21.0.11+9-LTS, mixed mode)`;

const CORRETTO_11 = `openjdk version "11.0.22" 2026-01-16 LTS
OpenJDK Runtime Environment Corretto-11.0.22.7.1 (build 11.0.22+7-LTS)`;

const OPENJDK_8 = `openjdk version "1.8.0_402"
OpenJDK Runtime Environment (build 1.8.0_402-b06)`;

test("an Oracle build is rejected, and the reason names the actual cause", () => {
  const r = classify(ORACLE_17, "C:\\Program Files\\Java\\jdk-17", "installed");
  assert.ok(r);
  assert.equal(r.major, 17);
  assert.equal(r.vendor, "Oracle");
  assert.equal(r.usable, false);
  // The version is fine; it is BouncyCastle that breaks. Saying "too old" here
  // would send someone to install a newer Oracle JDK, which also fails.
  assert.match(r.reason ?? "", /BouncyCastle/);
});

test("the legacy 1.8 scheme reports Java 8, not Java 1", () => {
  // `version "1.8.0_341"` — read naively the major is 1, which rejects it for
  // being ancient rather than for being Oracle, and prints "Java 1".
  const r = classify(ORACLE_8, "/opt/jdk8", "installed");
  assert.ok(r);
  assert.equal(r.major, 8);
});

test("a modern OpenJDK build is usable", () => {
  const r = classify(TEMURIN_21, "/opt/temurin", "installed");
  assert.ok(r);
  assert.equal(r.major, 21);
  assert.equal(r.usable, true);
  assert.equal(r.reason, undefined);
});

test("Corretto is not mistaken for Oracle", () => {
  // Amazon's banner says neither Oracle nor Temurin; it must not be caught by
  // a vendor check that looks only for the absence of a known-good name.
  const r = classify(CORRETTO_11, "/opt/corretto", "JAVA_HOME");
  assert.ok(r);
  assert.equal(r.usable, true);
  assert.equal(r.major, 11);
});

test("an OpenJDK that is simply too old is rejected for being old", () => {
  const r = classify(OPENJDK_8, "/opt/openjdk8", "PATH");
  assert.ok(r);
  assert.equal(r.major, 8);
  assert.equal(r.usable, false);
  assert.match(r.reason ?? "", /too old/);
  assert.doesNotMatch(r.reason ?? "", /BouncyCastle/);
});

test("output that is not a java banner yields nothing", () => {
  assert.equal(classify("bash: java: command not found", "/nope", "PATH"), undefined);
  assert.equal(classify("", "/nope", "PATH"), undefined);
});

test("the failure message lists what was found and why each was refused", () => {
  // "No JDK found" on a machine with three of them is a worse message than
  // none: the user reasonably concludes the tool is broken.
  const considered: JdkInfo[] = [
    classify(ORACLE_17, "C:\\Program Files\\Java\\jdk-17", "installed")!,
    classify(OPENJDK_8, "/opt/openjdk8", "PATH")!,
  ];
  const msg = explainNoJdk(considered);
  assert.match(msg, /jdk-17/);
  assert.match(msg, /BouncyCastle/);
  assert.match(msg, /too old/);
  // And it must say what to do about it.
  assert.match(msg, /--java-home|JAVA_HOME/);
  assert.match(msg, /Temurin|Zulu|Corretto/);
});
