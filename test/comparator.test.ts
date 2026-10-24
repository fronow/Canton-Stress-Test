// The design cost comparator (docs/cost-comparator.html) is a published claim:
// its constants are measured bills, and its prices follow the Universal
// Burn deck (CIP-0129, illustrative curve). These tests load the model straight out of the page and pin it to
// both, so editing a number in the page without new evidence fails the build.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../docs/cost-comparator.html", import.meta.url), "utf8");
const src = html.slice(html.indexOf("// MODEL START"), html.indexOf("// MODEL END"));
const ctx: Record<string, unknown> = {};
vm.runInNewContext(`${src}; this.api = { MODEL, txBytes, pricePerMb, cost };`, ctx);
const { txBytes, cost } = ctx.api as {
  txBytes: (d: Record<string, unknown>) => { submitter: number; network: number };
  cost: (bytes: number, o: Record<string, unknown>) => { perTx: number };
};

const design = (over: Record<string, unknown>) => ({
  family: "std", settlement: "direct", receiverRemote: false, confirmingNodes: 0,
  partiesPerNode: 1, observerNodes: 0, inputs: 1, dataBytes: 0, ...over,
});
const pricing = (over: Record<string, unknown>) => ({
  tps: 1, sync: "dedicated", collateral: 0, years: 0, listPrice: 60, net: false, ...over,
});
const typical = 1e6 / 60;
const near = (a: number, b: number, tol: number) =>
  assert.ok(Math.abs(a - b) <= tol, `${a} not within ${tol} of ${b}`);

test("prices reproduce the Universal Burn deck's own examples", () => {
  // List price: a typical 16.7 KB transaction is $1.
  near(cost(typical, pricing({ sync: "global", tps: 1000 })).perTx, 1, 1e-9);
  // Volume curve on a dedicated synchronizer: 50¢ / 25¢ / 12.5¢ at 10 / 100 / 1,000 TPS.
  near(cost(typical, pricing({ tps: 10 })).perTx, 0.5, 1e-9);
  near(cost(typical, pricing({ tps: 100 })).perTx, 0.25, 1e-9);
  near(cost(typical, pricing({ tps: 1000 })).perTx, 0.125, 1e-9);
  // 10 TPS with a 1-year commitment at 20% collateral: 25¢; held four years: 10¢.
  near(cost(typical, pricing({ tps: 10, collateral: 0.2 })).perTx, 0.25, 1e-9);
  near(cost(typical, pricing({ tps: 10, collateral: 0.2, years: 4 })).perTx, 0.1, 1e-9);
  // 1,000 TPS committed: 6.25¢.
  near(cost(typical, pricing({ tps: 1000, collateral: 0.2 })).perTx, 0.0625, 1e-9);
  // 100% collateral: about 74% off the volume price.
  near(cost(typical, pricing({ tps: 1, collateral: 1 })).perTx, 0.26, 0.005);
});

test("byte estimates reproduce measured bills within 5%", () => {
  const within5 = (model: number, measured: number) => near(model, measured, measured * 0.05);
  // Receiver on its own node, std-spike (role grid, 6,088 B).
  within5(txBytes(design({ receiverRemote: true })).submitter, 6088);
  // OpenZeppelin preapproved vs propose + accept (reference table).
  assert.equal(txBytes(design({ family: "oz" })).submitter, 4448);
  assert.equal(txBytes(design({ family: "oz", settlement: "twostep" })).submitter, 8554);
  // Amulet offer (two-step, first step), DSO on 8 hosts (submitter 6,175 B; all nodes 9,120 B).
  const offer = { family: "amulet", settlement: "offer" };
  within5(txBytes(design({ ...offer, confirmingNodes: 7 })).submitter, 6175);
  within5(txBytes(design({ ...offer, confirmingNodes: 7 })).network, 9120);
  // Amulet offer, DSO on 2 and 3 hosts with the receiver on a node of its own (P5, P4).
  within5(txBytes(design({ ...offer, receiverRemote: true, confirmingNodes: 1 })).submitter, 7397);
  within5(txBytes(design({ ...offer, receiverRemote: true, confirmingNodes: 2 })).submitter, 7846);
  // Amulet offer, DSO on 43 hosts (15,119 B).
  within5(txBytes(design({ ...offer, confirmingNodes: 42 })).submitter, 15119);
  // Amulet at MainNet's 13 DSO hosts (rounds 7 and 8): through a preapproval,
  // sender 8,357 B and all nodes 15,675 B; offer + accept, users 14,963 B and
  // all nodes 25,501 B.
  within5(txBytes(design({ family: "amulet", confirmingNodes: 12 })).submitter, 8357);
  within5(txBytes(design({ family: "amulet", confirmingNodes: 12 })).network, 15675);
  within5(txBytes(design({ family: "amulet", settlement: "twostep", confirmingNodes: 12 })).submitter, 14963);
  within5(txBytes(design({ family: "amulet", settlement: "twostep", confirmingNodes: 12 })).network, 25501);
  // Three input holdings (round 4, 4,409 B).
  within5(txBytes(design({ inputs: 3 })).submitter, 4409);
});
