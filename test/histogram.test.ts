import assert from "node:assert/strict";
import { test } from "node:test";
import { bucketIndex, bucketLowerBound, LatencyHistogram } from "../src/histogram.ts";
import { percentile } from "../src/metrics.ts";

const exact = (xs: number[], p: number): number => percentile([...xs].sort((a, b) => a - b), p);
const relErr = (got: number, want: number): number => (want === 0 ? Math.abs(got) : Math.abs(got - want) / want);

test("bucket indexing is monotonic and its bounds are self-consistent", () => {
  let prev = -1;
  for (const us of [0, 1, 127, 128, 255, 256, 511, 512, 1000, 1e6, 3.6e9]) {
    const i = bucketIndex(us);
    assert.ok(i >= prev, `index must not decrease: ${us}`);
    prev = i;
    // The value must fall inside the bucket the index claims.
    assert.ok(bucketLowerBound(i) <= us, `${us} below its own bucket's lower bound`);
    assert.ok(bucketLowerBound(i + 1) > us, `${us} should not reach the next bucket`);
  }
});

test("percentiles match exact computation within the histogram's resolution", () => {
  // A spread that crosses several magnitudes: sub-millisecond to seconds.
  const xs: number[] = [];
  for (let i = 0; i < 20_000; i++) xs.push(0.4 + (i % 997) * 0.9);
  for (let i = 0; i < 2_000; i++) xs.push(500 + (i % 251) * 7); // a slow tail
  for (let i = 0; i < 50; i++) xs.push(9000 + i); // a few very slow

  const h = LatencyHistogram.from(xs);
  assert.equal(h.count, xs.length);
  for (const p of [50, 90, 95, 99, 99.9]) {
    const err = relErr(h.percentile(p), exact(xs, p));
    assert.ok(err < 0.01, `p${p}: ${h.percentile(p)} vs ${exact(xs, p)} — ${(err * 100).toFixed(2)}% error`);
  }
  // Extremes are tracked exactly, not approximated.
  assert.equal(h.maxMs, Math.max(...xs));
});

test("MERGING IS EXACT — the property that makes bounded memory safe", () => {
  // Percentiles cannot be averaged across workers; histograms can be added.
  // Merging N of them must be indistinguishable from recording every sample
  // into one histogram, or the whole approach is unsound.
  const shards = [
    Array.from({ length: 5000 }, (_, i) => 1 + (i % 300) * 0.5),
    Array.from({ length: 3000 }, (_, i) => 200 + (i % 700) * 1.3),
    Array.from({ length: 900 }, (_, i) => 4000 + i),
  ];
  const merged = new LatencyHistogram();
  for (const s of shards) merged.merge(LatencyHistogram.from(s));
  const all = LatencyHistogram.from(shards.flat());

  assert.equal(merged.count, all.count);
  assert.equal(merged.maxMs, all.maxMs);
  for (const p of [1, 50, 90, 99, 99.9, 100])
    assert.equal(merged.percentile(p), all.percentile(p), `p${p} must be identical after merge`);
});

test("memory is bounded by RANGE, not by operation count", () => {
  // This is the scaling claim: ten million operations must not cost ten
  // million anything.
  const h = new LatencyHistogram();
  for (let i = 0; i < 1_000_000; i++) h.record(1 + (i % 5000) * 0.4);
  assert.equal(h.count, 1_000_000);
  assert.ok(h.bucketsUsed < 2000, `expected a small bucket set, used ${h.bucketsUsed}`);

  // And a run spanning microseconds to an hour is still tiny.
  const wide = new LatencyHistogram();
  for (const ms of [0.001, 0.1, 1, 10, 100, 1000, 60_000, 3_600_000]) wide.record(ms);
  assert.ok(wide.bucketsUsed <= 8);
});

test("round-trips through JSON, which is how a worker ships it", () => {
  const h = LatencyHistogram.from([1, 2, 3, 50, 900, 12_000]);
  const back = LatencyHistogram.fromJSON(JSON.parse(JSON.stringify(h.toJSON())));
  assert.equal(back.count, h.count);
  assert.equal(back.maxMs, h.maxMs);
  assert.equal(back.meanMs, h.meanMs);
  for (const p of [50, 99, 100]) assert.equal(back.percentile(p), h.percentile(p));
});

test("an empty histogram reports zeros rather than NaN", () => {
  const h = new LatencyHistogram();
  assert.equal(h.count, 0);
  assert.equal(h.percentile(99), 0);
  assert.equal(h.meanMs, 0);
  assert.equal(h.maxMs, 0);
  // And merging an empty one changes nothing.
  const a = LatencyHistogram.from([5, 10]);
  a.merge(new LatencyHistogram());
  assert.equal(a.count, 2);
});

test("a single sample is reported at its own value, not a bucket edge", () => {
  const h = LatencyHistogram.from([42.5]);
  assert.equal(h.percentile(50), 42.5);
  assert.equal(h.percentile(100), 42.5);
});
