import { describe, expect, it } from 'vite-plus/test'
import { shrinkPlan } from '../src/shrink.ts'
import { Rng, randomSeed } from '../src/rng.ts'
import type { FuzzPlan } from '../src/types.ts'

const files = Array.from({ length: 24 }, (_, i) => `c/${String(i).padStart(2, '0')}.vue`)

const plan: FuzzPlan = {
  seed: 1,
  caseId: 'c',
  targetId: 't',
  specimenId: 's.vue',
  appMode: 'vdom-interop',
  strategy: 'uniform',
  density: 1,
  vaporFiles: files,
}

describe('shrinkPlan', () => {
  it('isolates a single culprit', async () => {
    const culprit = files[17] as string
    let probes = 0
    const result = await shrinkPlan(plan, async (candidate) => {
      probes++
      return candidate.vaporFiles.includes(culprit)
    })
    expect(result.plan.vaporFiles).toEqual([culprit])
    expect(probes).toBeLessThan(40)
  })

  it('isolates a pair that only fails together', async () => {
    const a = files[3] as string
    const b = files[20] as string
    const result = await shrinkPlan(
      plan,
      async (c) => c.vaporFiles.includes(a) && c.vaporFiles.includes(b),
      { maxProbes: 200 },
    )
    expect(result.plan.vaporFiles).toContain(a)
    expect(result.plan.vaporFiles).toContain(b)
    expect(result.plan.vaporFiles.length).toBeLessThan(files.length)
  })

  it('reports exhaustion instead of pretending it minimised', async () => {
    const result = await shrinkPlan(plan, async () => true, { maxProbes: 3 })
    expect(result.exhausted).toBe(true)
    expect(result.probes).toBeLessThanOrEqual(3)
  })

  it('never spends a probe on a plan it has already tried', async () => {
    const seen: string[] = []
    await shrinkPlan(plan, async (c) => {
      seen.push(c.vaporFiles.join(','))
      return c.vaporFiles.includes(files[0] as string)
    })
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('leaves a single-file plan alone', async () => {
    const single = { ...plan, vaporFiles: [files[0] as string] }
    const result = await shrinkPlan(single, async () => true)
    expect(result.plan.vaporFiles).toEqual(single.vaporFiles)
  })
})

describe('Rng', () => {
  it('is reproducible and independent of call history', () => {
    const a = new Rng(1234)
    const b = new Rng(1234)
    expect(Array.from({ length: 20 }, () => a.next())).toEqual(
      Array.from({ length: 20 }, () => b.next()),
    )
  })

  it('stays inside the requested integer range', () => {
    const rng = new Rng(7)
    for (let i = 0; i < 2000; i++) {
      const n = rng.int(3, 9)
      expect(n).toBeGreaterThanOrEqual(3)
      expect(n).toBeLessThanOrEqual(9)
    }
  })

  it('shuffles without losing or duplicating items', () => {
    const rng = new Rng(11)
    const input = Array.from({ length: 50 }, (_, i) => i)
    const out = rng.shuffle(input)
    expect(out).not.toEqual(input)
    expect([...out].toSorted((x, y) => x - y)).toEqual(input)
  })

  it('survives a zero seed', () => {
    expect(Number.isFinite(new Rng(0).next())).toBe(true)
  })

  it('produces 32-bit seeds', () => {
    for (let i = 0; i < 100; i++) {
      const seed = randomSeed()
      expect(Number.isInteger(seed)).toBe(true)
      expect(seed).toBeGreaterThanOrEqual(0)
      expect(seed).toBeLessThanOrEqual(0xffffffff)
    }
  })
})
