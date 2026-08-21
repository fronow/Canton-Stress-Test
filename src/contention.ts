// The contention model, as code.
//
// A wallet that picks its input holdings at random collides with itself. Two
// measured results describe how often, and this turns them into arithmetic the
// tool can do while a run is still on screen — which is what lets a report say
// "hold 2,400 instead of 480" rather than "contention was 12.5%".
//
// THE TURNOVER LAW (single input). Contention is not a concurrency effect: it
// is bookkeeping. Over a run the spent fraction of the pool grows from zero to
// `f`, so the average chance that a randomly chosen holding is already spent is
// about `f / 2`. Measured across an eightfold range of pool depth, contention
// halved every time the pool doubled, with a mean error of about two points;
// raising concurrency fourfold moved it by less than one.
//
// THE MULTI-INPUT EXTENSION. A transfer that must gather `k` holdings fails if
// ANY ONE of them is already spent, so the survival probability is `(1 - p)^k`
// rather than `1 - k·p`. Degradation is geometric in `k`, not linear — the
// intuitive "k inputs behaves like a pool k times smaller" understates the
// damage roughly twofold. Failures consume nothing, so the pool is drawn down
// only by transfers that commit, which makes the two quantities mutually
// dependent and the model a fixed point.
//
// HONESTY. At k = 1 this reduces to `f / 2`, so it generalises the turnover law
// rather than replacing it. It is an estimate and a floor, not an identity: it
// under-predicts where genuine concurrent collisions add on top of the
// bookkeeping effect. Against measurements it lands within a couple of points
// where it was fitted and within about seven points out of sample. Treat its
// output as a size, not a specification.

export interface ContentionInputs {
  /** Transfers attempted before the pool is topped up. */
  ops: number;
  /** Holdings the wallet can spend from. */
  pool: number;
  /** Holdings each transfer must gather. Default 1. */
  inputs?: number;
}

/**
 * Expected fraction of transfers that fail and need a retry, in [0, 1).
 *
 * Solves `c = (1 - c·k·ops / (2·pool))^k` for the committed share `c` and
 * returns `1 - c`.
 */
export function predictContention({ ops, pool, inputs = 1 }: ContentionInputs): number {
  if (!(ops > 0) || !(pool > 0) || !(inputs > 0)) return 0;
  const k = inputs;
  // Consumption per unit of committed share: k transfers' worth of holdings
  // against the pool, halved because the spent fraction ramps from 0 to f.
  const rate = (k * ops) / (2 * pool);

  const g = (c: number): number => {
    const base = 1 - c * rate;
    if (base <= 0) return 0;
    return Math.pow(base, k);
  };

  // Plain iteration OSCILLATES rather than converges once k is large (at k=8
  // it flips between ~0.02 and ~0.95 forever), because g is steep and
  // decreasing. Averaging each step with the previous value damps that out and
  // converges on the same fixed point.
  let c = 0.5;
  for (let i = 0; i < 200; i++) {
    const next = (c + g(c)) / 2;
    if (Math.abs(next - c) < 1e-12) {
      c = next;
      break;
    }
    c = next;
  }
  return Math.min(1, Math.max(0, 1 - c));
}

/**
 * The smallest pool that keeps expected contention at or below `target`.
 *
 * This is the number that turns a diagnosis into an instruction. Returns
 * `undefined` when no pool reaches the target, which happens once a transfer
 * needs so many inputs that gathering them is itself the problem.
 */
export function poolForTarget(o: {
  ops: number;
  target: number;
  inputs?: number;
}): number | undefined {
  const { ops, target, inputs = 1 } = o;
  if (!(ops > 0) || !(target > 0)) return undefined;

  // Contention falls monotonically as the pool grows, so bisect. The ceiling
  // is generous but finite: beyond it the honest answer is "not by adding
  // holdings".
  let lo = 1;
  let hi = Math.max(2, Math.ceil(ops * inputs * 1000));
  if (predictContention({ ops, pool: hi, inputs }) > target) return undefined;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (predictContention({ ops, pool: mid, inputs }) <= target) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}
