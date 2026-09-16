import { describe, expect, it } from 'vite-plus/test'
import {
  compareObservations,
  findingSignature,
  normalizeErrorText,
  renderDiff,
} from '../src/diff.ts'
import type { CaseObservation, FuzzPlan } from '../src/types.ts'

const plan: FuzzPlan = {
  seed: 1,
  caseId: 'c',
  targetId: 't',
  specimenId: 's.vue',
  appMode: 'vdom-interop',
  strategy: 'uniform',
  density: 0.5,
  vaporFiles: ['a.vue'],
}

const observe = (over: Partial<CaseObservation> = {}): CaseObservation => ({
  mounted: true,
  snapshots: [{ label: 'initial', html: '<p>\n  #text hi\n', text: 'hi' }],
  consoleErrors: [],
  consoleWarnings: [],
  pageErrors: [],
  ...over,
})

describe('renderDiff', () => {
  it('reports scattered single-line changes as scattered', () => {
    // A first/last-divergence window would mark everything between the two
    // changed lines as deleted, which reads as "the subtree vanished".
    const a = ['<a>', '<b x="1">', '<c>', '<d>', '<e>', '<f y="1">', '<g>'].join('\n')
    const b = ['<a>', '<b x="2">', '<c>', '<d>', '<e>', '<f y="2">', '<g>'].join('\n')
    const diff = renderDiff(a, b)
    expect(diff).toContain('- <b x="1">')
    expect(diff).toContain('+ <b x="2">')
    expect(diff).not.toContain('- <d>')
  })

  it('says so when the inputs are identical', () => {
    expect(renderDiff('same', 'same')).toContain('no line-level difference')
  })
})

describe('normalizeErrorText', () => {
  it('erases the coordinates that differ between two dev servers', () => {
    const a = 'TypeError: x at http://127.0.0.1:5190/@fs/a/b/Comp.vue:12:3'
    const b = 'TypeError: x at http://127.0.0.1:5311/@fs/a/b/Comp.vue:44:9'
    expect(normalizeErrorText(a)).toBe(normalizeErrorText(b))
  })
})

describe('compareObservations', () => {
  it('reports nothing for identical observations', () => {
    expect(compareObservations(observe(), observe(), plan)).toHaveLength(0)
  })

  it('reports one finding, not three, when the mutant never mounted', () => {
    const findings = compareObservations(
      observe(),
      observe({ mounted: false, snapshots: [], consoleErrors: ['boom'] }),
      plan,
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]?.kind).toBe('runtime-error')
  })

  it('ignores errors the baseline already produced', () => {
    const shared = ['already broken at http://127.0.0.1:1/x.vue:1:1']
    const findings = compareObservations(
      observe({ consoleErrors: shared }),
      observe({ consoleErrors: ['already broken at http://127.0.0.1:2/x.vue:9:9'] }),
      plan,
    )
    expect(findings).toHaveLength(0)
  })

  it('classifies the slotted scope id as a known divergence', () => {
    const findings = compareObservations(
      observe({ snapshots: [{ label: 'initial', html: '<b>\n', text: '' }] }),
      observe({ snapshots: [{ label: 'initial', html: '<b data-v-1a2b3c4d-s="">\n', text: '' }] }),
      plan,
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]?.knownDivergence).toBe('vapor-slotted-scope-id')
  })

  it('leaves a partly-explained mismatch unclassified', () => {
    const findings = compareObservations(
      observe({ snapshots: [{ label: 'initial', html: '<b>\n', text: '' }] }),
      observe({
        snapshots: [{ label: 'initial', html: '<b data-v-1a2b3c4d-s="" hidden="">\n', text: '' }],
      }),
      plan,
    )
    expect(findings[0]?.knownDivergence).toBeUndefined()
  })

  it('attributes the wreckage of a known crash to that crash', () => {
    const findings = compareObservations(
      observe(),
      observe({
        snapshots: [{ label: 'initial', html: '', text: '' }],
        consoleErrors: [
          'TypeError: dir is not a function\n    at applyDirectivesToElement (http://x/y.js:1:1)',
        ],
      }),
      plan,
    )
    expect(findings.length).toBeGreaterThan(1)
    for (const finding of findings) {
      expect(finding.knownDivergence).toBe('vapor-object-directive-unsupported')
    }
  })

  it('reports a trace that could not be replayed', () => {
    const findings = compareObservations(
      observe(),
      observe({ traceStoppedAt: 'action 2 (click .x)' }),
      plan,
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]?.detail).toContain('action 2')
  })
})

describe('findingSignature', () => {
  it('is stable across dev-server coordinates', () => {
    const a = findingSignature([
      {
        kind: 'runtime-error',
        summary: 's',
        detail: 'TypeError: x\n    at http://127.0.0.1:1/a.vue:1:1',
      },
    ])
    const b = findingSignature([
      {
        kind: 'runtime-error',
        summary: 's',
        detail: 'TypeError: x\n    at http://127.0.0.1:2/a.vue:9:9',
      },
    ])
    expect(a).toBe(b)
  })

  it('separates different errors so the shrinker cannot drift onto another bug', () => {
    const a = findingSignature([{ kind: 'runtime-error', summary: 's', detail: 'TypeError: x' }])
    const b = findingSignature([{ kind: 'runtime-error', summary: 's', detail: 'TypeError: y' }])
    expect(a).not.toBe(b)
  })

  it('falls back to the set of kinds when there is no error text', () => {
    expect(findingSignature([{ kind: 'dom-mismatch', summary: 's', detail: 'diff' }])).toBe(
      'kind:dom-mismatch',
    )
  })
})
