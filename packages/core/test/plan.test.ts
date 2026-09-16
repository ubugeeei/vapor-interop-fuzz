import { describe, expect, it } from 'vite-plus/test'
import { generatePlan, planKey } from '../src/plan.ts'
import type { Candidate } from '../src/types.ts'

const candidate = (id: string, depth: number, eligible = true): Candidate => ({
  id,
  absPath: `/x/${id}`,
  kind: 'sfc',
  eligible,
  authoredVapor: false,
  depth,
})

const ROOT = 'root.vue'
const candidates: Candidate[] = [
  candidate(ROOT, 0),
  candidate('a/one.vue', 1),
  candidate('a/two.vue', 1),
  candidate('b/three.vue', 2),
  candidate('b/four.vue', 2),
  candidate('c/five.vue', 3),
]

const base = { targetId: 't', specimenId: ROOT, candidates, rootId: ROOT }

describe('generatePlan', () => {
  it('is a pure function of the seed', () => {
    for (const seed of [1, 42, 9999]) {
      expect(planKey(generatePlan({ ...base, seed }))).toBe(
        planKey(generatePlan({ ...base, seed })),
      )
    }
  })

  it('only ever selects eligible candidates', () => {
    const mixed = [...candidates, candidate('d/six.vue', 1, false)]
    for (let seed = 1; seed < 80; seed++) {
      const plan = generatePlan({ ...base, candidates: mixed, seed })
      expect(plan.vaporFiles).not.toContain('d/six.vue')
    }
  })

  it('keeps the root component in step with the app runtime', () => {
    // `createVaporApp()` mounts its root through vapor's `createComponent`, so a
    // virtual-DOM root in a Vapor app is an API misuse, not an interop bug.
    for (let seed = 1; seed < 200; seed++) {
      const plan = generatePlan({ ...base, seed })
      const rootIsVapor = plan.vaporFiles.includes(ROOT)
      if (plan.appMode === 'vapor-interop' || plan.appMode === 'vapor-only') {
        expect(rootIsVapor).toBe(true)
      } else {
        expect(rootIsVapor).toBe(false)
      }
    }
  })

  it('never pairs an unbridged app with a mixed tree', () => {
    for (let seed = 1; seed < 200; seed++) {
      const plan = generatePlan({ ...base, seed })
      if (plan.appMode === 'vdom-only') expect(plan.vaporFiles).toHaveLength(0)
      if (plan.appMode === 'vapor-only') expect(plan.vaporFiles).toHaveLength(candidates.length)
    }
  })

  it('will not draw pure-vapor when something in the tree cannot convert', () => {
    const mixed = [...candidates, candidate('d/six.vue', 1, false)]
    for (let seed = 1; seed < 200; seed++) {
      expect(generatePlan({ ...base, candidates: mixed, seed }).appMode).not.toBe('vapor-only')
    }
  })

  it('never draws a Vapor-root shape when the root cannot be Vapor', () => {
    // `createVaporApp` mounts its root through vapor's `createComponent`, so a
    // root that cannot compile in Vapor Mode would crash for a reason that has
    // nothing to do with interop.
    const withVdomRoot = [candidate(ROOT, 0, false), ...candidates.slice(1)]
    for (let seed = 1; seed < 200; seed++) {
      const plan = generatePlan({ ...base, candidates: withVdomRoot, seed })
      expect(plan.appMode).not.toBe('vapor-only')
      expect(plan.appMode).not.toBe('vapor-interop')
    }
  })

  it('produces sorted, duplicate-free file lists', () => {
    for (let seed = 1; seed < 60; seed++) {
      const { vaporFiles } = generatePlan({ ...base, seed })
      expect([...vaporFiles]).toEqual([...vaporFiles].toSorted())
      expect(new Set(vaporFiles).size).toBe(vaporFiles.length)
    }
  })

  it('boundary alternates by depth so most parent/child edges are a boundary', () => {
    const plan = generatePlan({
      ...base,
      seed: 5,
      appMode: 'vdom-interop',
      strategy: 'boundary',
      rootId: undefined,
    })
    const depths = new Set(
      candidates.filter((c) => plan.vaporFiles.includes(c.id)).map((c) => c.depth % 2),
    )
    expect(depths.size).toBe(1)
  })

  it('clustered picks whole directories rather than scattered files', () => {
    const plan = generatePlan({
      ...base,
      seed: 21,
      appMode: 'vdom-interop',
      strategy: 'clustered',
      density: 0.5,
      rootId: undefined,
    })
    const dirs = new Set(plan.vaporFiles.map((f) => f.slice(0, f.lastIndexOf('/'))))
    for (const dir of dirs) {
      const inDir = candidates.filter((c) => c.id.startsWith(`${dir}/`))
      for (const c of inDir) expect(plan.vaporFiles).toContain(c.id)
    }
  })
})
