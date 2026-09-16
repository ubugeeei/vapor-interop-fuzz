/**
 * Deterministic RNG. Every random decision the fuzzer makes goes through here,
 * so a seed plus a target is a complete description of a run -- which is what
 * makes `vp run fuzz:replay` able to reproduce a finding exactly.
 */
export class Rng {
  #state: number

  constructor(seed: number) {
    // Avoid the degenerate 0 state of the mulberry32 family.
    this.#state = seed >>> 0 || 0x9e3779b9
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0
    let t = this.#state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  /** Uniform integer in [min, max]. */
  int(min: number, max: number): number {
    if (max < min) throw new RangeError(`int(${min}, ${max}): empty range`)
    return min + Math.floor(this.next() * (max - min + 1))
  }

  bool(probability = 0.5): boolean {
    return this.next() < probability
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError('pick() on an empty array')
    return items[this.int(0, items.length - 1)] as T
  }

  /** Fisher-Yates on a copy. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items]
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i)
      const a = out[i] as T
      const b = out[j] as T
      out[i] = b
      out[j] = a
    }
    return out
  }

  /** Random subset with independent per-item probability. */
  subset<T>(items: readonly T[], probability: number): T[] {
    return items.filter(() => this.bool(probability))
  }
}

/** Seed derived from the clock, printed by the runner so it can be replayed. */
export function randomSeed(): number {
  return (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0
}
