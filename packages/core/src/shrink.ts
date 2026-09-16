import { planKey } from './plan.ts'
import type { FuzzPlan } from './types.ts'

/** Returns true when the plan still reproduces the failure. */
export type ReproProbe = (plan: FuzzPlan) => Promise<boolean>

export interface ShrinkOptions {
  readonly maxProbes?: number
  readonly onProbe?: (plan: FuzzPlan, reproduced: boolean, probeCount: number) => void
}

export interface ShrinkResult {
  readonly plan: FuzzPlan
  readonly probes: number
  readonly exhausted: boolean
}

/**
 * Delta-debug the set of Vapor files down to a minimal reproducer.
 *
 * A raw finding is typically "47 of these 61 components were Vapor and the DOM
 * differed", which is unactionable. ddmin turns that into "these two components
 * on either side of a slot boundary", which is a bug report.
 */
export async function shrinkPlan(
  plan: FuzzPlan,
  reproduces: ReproProbe,
  options: ShrinkOptions = {},
): Promise<ShrinkResult> {
  const maxProbes = options.maxProbes ?? 40
  const cache = new Map<string, boolean>()
  let probes = 0

  const probe = async (candidate: FuzzPlan): Promise<boolean> => {
    const key = planKey(candidate)
    const cached = cache.get(key)
    if (cached !== undefined) return cached
    if (probes >= maxProbes) return false
    probes++
    const result = await reproduces(candidate)
    cache.set(key, result)
    options.onProbe?.(candidate, result, probes)
    return result
  }

  const withFiles = (files: readonly string[]): FuzzPlan => ({
    ...plan,
    strategy: 'uniform',
    vaporFiles: [...files].toSorted(),
  })

  let current = [...plan.vaporFiles]
  let granularity = 2

  // `probes` is incremented inside `probe()`, which the linter cannot see.
  // oxlint-disable-next-line eslint/no-unmodified-loop-condition
  while (current.length > 1 && probes < maxProbes) {
    const chunks = splitInto(current, Math.min(granularity, current.length))
    let reduced = false

    // Try each chunk on its own first -- the common case is a single culprit.
    for (const chunk of chunks) {
      if (chunk.length === 0 || chunk.length === current.length) continue
      if (await probe(withFiles(chunk))) {
        current = chunk
        granularity = 2
        reduced = true
        break
      }
    }
    if (reduced) continue

    // Then try removing each chunk (the complement).
    for (const chunk of chunks) {
      if (chunk.length === 0) continue
      const complement = current.filter((f) => !chunk.includes(f))
      if (complement.length === 0 || complement.length === current.length) continue
      if (await probe(withFiles(complement))) {
        current = complement
        granularity = Math.max(granularity - 1, 2)
        reduced = true
        break
      }
    }
    if (reduced) continue

    if (granularity >= current.length) break
    granularity = Math.min(granularity * 2, current.length)
  }

  return {
    plan: withFiles(current),
    probes,
    exhausted: probes >= maxProbes,
  }
}

function splitInto<T>(items: readonly T[], parts: number): T[][] {
  const out: T[][] = []
  const size = Math.ceil(items.length / parts)
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
