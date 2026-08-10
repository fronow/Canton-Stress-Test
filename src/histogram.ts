// Bounded-memory latency histogram (institutional scale).
//
// Retaining one sample per operation is fine for a 60-second sandbox run and
// fatal at the scale institutions actually test: 10 million operations is
// gigabytes of objects per worker, and the distributed path serialises every
// one of them through IPC to be merged. That does not degrade — it runs out
// of memory.
//
// The obvious fix — have each worker report its own percentiles — is the one
// thing that must not be done: percentiles are order statistics and cannot be
// averaged (see cluster.ts). A HISTOGRAM escapes the dilemma, because
// histograms MERGE EXACTLY: add the bucket counts and the result is
// indistinguishable from having recorded every sample into one place. Bounded
// memory, and the correctness argument is preserved rather than traded away.
//
// The layout is the standard HdrHistogram one: a linear region for small
// values, then `SUB` linear sub-buckets per power of two. That gives a bounded
// RELATIVE error at every magnitude — 0.4% here — instead of the absolute
// error a fixed bucket width would give, which is what makes it usable across
// microseconds and minutes at once.

/** Sub-buckets per power of two. 128 → worst-case 0.39% error using midpoints. */
const SUB = 128;
const L = Math.log2(SUB); // 7

/** Values are held as integer MICROSECONDS: latency arrives in fractional ms,
 * and integer bucketing avoids float drift in the index arithmetic. */
const toUs = (ms: number): number => Math.max(0, Math.round(ms * 1000));

/** Bucket index for a microsecond value. */
export function bucketIndex(us: number): number {
  if (us < SUB) return us;
  const m = Math.floor(Math.log2(us));
  const k = m - L; // magnitude above the linear region
  const width = 2 ** k;
  return SUB + k * SUB + (Math.floor(us / width) - SUB);
}

/** Lowest microsecond value that lands in this bucket. */
export function bucketLowerBound(index: number): number {
  if (index < SUB) return index;
  const k = Math.floor((index - SUB) / SUB);
  const sub = (index - SUB) % SUB;
  return (SUB + sub) * 2 ** k;
}

const bucketWidth = (index: number): number =>
  index < SUB ? 1 : 2 ** Math.floor((index - SUB) / SUB);

export interface HistogramJson {
  counts: number[];
  count: number;
  minUs: number;
  maxUs: number;
  sumUs: number;
}

/** A latency distribution in bounded memory. */
export class LatencyHistogram {
  private counts: number[] = [];
  count = 0;
  /** Exact extremes, kept outside the buckets so they are not approximated. */
  minUs = Infinity;
  maxUs = 0;
  private sumUs = 0;

  /** Record a latency in milliseconds. */
  record(ms: number): void {
    const us = toUs(ms);
    const i = bucketIndex(us);
    this.counts[i] = (this.counts[i] ?? 0) + 1;
    this.count++;
    this.sumUs += us;
    if (us < this.minUs) this.minUs = us;
    if (us > this.maxUs) this.maxUs = us;
  }

  /** Add another histogram into this one.
   *
   * Exact: bucket counts are additive, so merging N workers gives precisely
   * the distribution of every sample they recorded. This is the property that
   * lets the tool scale without giving up correct percentiles. */
  merge(other: LatencyHistogram): void {
    for (let i = 0; i < other.counts.length; i++) {
      const c = other.counts[i];
      if (c) this.counts[i] = (this.counts[i] ?? 0) + c;
    }
    this.count += other.count;
    this.sumUs += other.sumUs;
    if (other.minUs < this.minUs) this.minUs = other.minUs;
    if (other.maxUs > this.maxUs) this.maxUs = other.maxUs;
  }

  /** Nearest-rank percentile, in milliseconds. Matches `percentile()` in
   * metrics.ts to within the histogram's resolution. */
  percentile(p: number): number {
    if (this.count === 0) return 0;
    if (p >= 100) return this.maxUs / 1000;
    const target = Math.max(1, Math.ceil((p / 100) * this.count));
    let seen = 0;
    for (let i = 0; i < this.counts.length; i++) {
      const c = this.counts[i];
      if (!c) continue;
      seen += c;
      if (seen >= target) {
        // The midpoint halves the worst-case error versus either bound.
        const lo = bucketLowerBound(i);
        const value = lo + bucketWidth(i) / 2;
        // Never report beyond the extremes we actually observed.
        return Math.min(this.maxUs, Math.max(this.minUs, value)) / 1000;
      }
    }
    return this.maxUs / 1000;
  }

  get maxMs(): number {
    return this.maxUs / 1000;
  }
  get meanMs(): number {
    return this.count > 0 ? this.sumUs / this.count / 1000 : 0;
  }
  /** Buckets actually in use — the memory this run costs, regardless of ops. */
  get bucketsUsed(): number {
    return this.counts.reduce((n, c) => n + (c ? 1 : 0), 0);
  }

  toJSON(): HistogramJson {
    return {
      counts: [...this.counts].map((c) => c ?? 0),
      count: this.count,
      minUs: this.minUs === Infinity ? 0 : this.minUs,
      maxUs: this.maxUs,
      sumUs: this.sumUs,
    };
  }

  static fromJSON(j: HistogramJson): LatencyHistogram {
    const h = new LatencyHistogram();
    h.counts = [...j.counts];
    h.count = j.count;
    h.minUs = j.count > 0 ? j.minUs : Infinity;
    h.maxUs = j.maxUs;
    h.sumUs = j.sumUs;
    return h;
  }

  static from(latenciesMs: number[]): LatencyHistogram {
    const h = new LatencyHistogram();
    for (const ms of latenciesMs) h.record(ms);
    return h;
  }
}
