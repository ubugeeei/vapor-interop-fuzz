import { Rng } from './rng.ts'
import {
  APP_MODES,
  BASELINE_APP_MODE,
  type AppMode,
  type Candidate,
  type FuzzPlan,
  type MutationStrategy,
} from './types.ts'

/**
 * A *shape* pairs an app-level mode with the component-level mutation it makes
 * sense with. Mixing freely would waste most of the budget on cases that are
 * guaranteed to fail for uninteresting reasons: a Vapor child inside a
 * `createApp()` without `vaporInteropPlugin` is *supposed* to blow up, and
 * "unbridged interop throws" is not a bug report anyone wants 200 copies of.
 */
export type CaseShape =
  /** Control: plain VDOM, no bridge. Must be byte-identical to the baseline. */
  | 'pure-vdom'
  /** Whole tree in Vapor with no bridge. The strongest "same output" assertion. */
  | 'pure-vapor'
  /** VDOM root, bridge installed, random Vapor islands. */
  | 'vdom-root-mixed'
  /** Vapor root, bridge installed, random VDOM islands. */
  | 'vapor-root-mixed'

export const CASE_SHAPES: readonly CaseShape[] = [
  'pure-vdom',
  'pure-vapor',
  'vdom-root-mixed',
  'vapor-root-mixed',
]

const SHAPE_WEIGHTS: Record<CaseShape, number> = {
  'pure-vdom': 1,
  'pure-vapor': 2,
  'vdom-root-mixed': 4,
  'vapor-root-mixed': 4,
}

const MIXED_STRATEGIES: readonly MutationStrategy[] = [
  'uniform',
  'uniform',
  'clustered',
  'boundary',
  'root-only',
]

export interface PlanInput {
  readonly seed: number
  readonly targetId: string
  readonly specimenId: string
  readonly candidates: readonly Candidate[]
  /**
   * Id of the specimen's own root component, when it is flippable.
   *
   * `createVaporApp()` mounts its root through vapor's `createComponent`, not
   * `createComponentWithFallback`, so a Vapor app whose root component is a
   * virtual-DOM component throws deep inside the runtime -- an API constraint,
   * not an interop bug. Pinning the root to match the app runtime keeps that
   * one known crash from drowning out every real finding.
   */
  readonly rootId?: string
  /**
   * False when the specimen's tree contains components the mutator cannot
   * flip -- a prebuilt library from npm, say.
   *
   * The `pure-vapor` shape installs no interop bridge at all, so a single
   * virtual-DOM component anywhere in the tree makes the case fail for a reason
   * that has nothing to do with the mutation. Vuetify is exactly this: the
   * specimens are flippable, the `v-*` components they render are not.
   */
  readonly treeFullyMutable?: boolean
  /** Pin the shape instead of drawing one. */
  readonly shape?: CaseShape
  readonly appMode?: AppMode
  readonly strategy?: MutationStrategy
  readonly density?: number
}

export function baselinePlan(input: Omit<PlanInput, 'seed'> & { seed?: number }): FuzzPlan {
  return {
    seed: input.seed ?? 0,
    caseId: `${input.targetId}/${input.specimenId}#baseline`,
    targetId: input.targetId,
    specimenId: input.specimenId,
    appMode: BASELINE_APP_MODE,
    strategy: 'none',
    density: 0,
    vaporFiles: [],
  }
}

export function generatePlan(input: PlanInput): FuzzPlan {
  const rng = new Rng(input.seed)
  const eligible = input.candidates.filter((c) => c.eligible)
  const everythingEligible =
    eligible.length === input.candidates.length &&
    eligible.length > 0 &&
    input.treeFullyMutable !== false

  // When the specimen root is the only thing the mutator can flip, a
  // virtual-DOM root leaves nothing to flip at all -- `constrainRoot` removes
  // the root from those modes by design. Drawing those shapes would spend the
  // budget re-rendering the baseline. This is the normal situation for a target
  // whose components come from a published package (Vuetify).
  const rootIsOnlyFlippable =
    input.rootId !== undefined &&
    eligible.length > 0 &&
    eligible.every((c) => c.id === input.rootId)

  const shape = input.shape ?? drawShape(rng, everythingEligible, rootIsOnlyFlippable)
  const { appMode, strategy } = resolveShape(shape, rng)

  const finalAppMode = input.appMode ?? appMode
  const finalStrategy = input.strategy ?? strategy
  const density = input.density ?? roundTo(0.15 + rng.next() * 0.7, 2)

  const vaporFiles = constrainRoot(
    selectVaporFiles(eligible, finalStrategy, density, rng),
    finalAppMode,
    input.rootId,
    eligible,
  )

  return {
    seed: input.seed,
    caseId: `${input.targetId}/${input.specimenId}#${input.seed}`,
    targetId: input.targetId,
    specimenId: input.specimenId,
    appMode: finalAppMode,
    strategy: finalStrategy,
    density,
    vaporFiles,
  }
}

function drawShape(rng: Rng, everythingEligible: boolean, rootIsOnlyFlippable: boolean): CaseShape {
  const pool: CaseShape[] = []
  for (const shape of CASE_SHAPES) {
    // `pure-vapor` has no bridge, so a single non-convertible component would
    // make the case fail for a reason that has nothing to do with interop.
    if (shape === 'pure-vapor' && !everythingEligible) continue
    if (shape === 'vdom-root-mixed' && rootIsOnlyFlippable) continue
    for (let i = 0; i < SHAPE_WEIGHTS[shape]; i++) pool.push(shape)
  }
  return rng.pick(pool)
}

function resolveShape(
  shape: CaseShape,
  rng: Rng,
): { appMode: AppMode; strategy: MutationStrategy } {
  switch (shape) {
    case 'pure-vdom':
      return { appMode: 'vdom-only', strategy: 'none' }
    case 'pure-vapor':
      return { appMode: 'vapor-only', strategy: 'all' }
    case 'vdom-root-mixed':
      return { appMode: 'vdom-interop', strategy: rng.pick(MIXED_STRATEGIES) }
    case 'vapor-root-mixed':
      return { appMode: 'vapor-interop', strategy: rng.pick(MIXED_STRATEGIES) }
  }
}

function selectVaporFiles(
  eligible: readonly Candidate[],
  strategy: MutationStrategy,
  density: number,
  rng: Rng,
): readonly string[] {
  const chosen = ((): Candidate[] => {
    switch (strategy) {
      case 'none':
        return []
      case 'all':
        return [...eligible]
      case 'root-only':
        return eligible.filter((c) => c.depth === 0)
      case 'uniform':
        return rng.subset(eligible, density)
      case 'boundary': {
        // Alternate by depth so that (almost) every parent/child edge in the
        // tree is a Vapor <-> VDOM boundary.
        const flip = rng.bool()
        return eligible.filter((c) => (c.depth % 2 === 0) !== flip)
      }
      case 'clustered': {
        // Flip whole directories: closer to how a real migration happens, and
        // it produces long same-mode runs that `uniform` almost never yields.
        const dirs = [...new Set(eligible.map((c) => dirOf(c.id)))]
        const picked = new Set(rng.subset(dirs, Math.max(density, 1 / Math.max(dirs.length, 1))))
        return eligible.filter((c) => picked.has(dirOf(c.id)))
      }
    }
  })()

  return [...new Set(chosen.map((c) => c.id))].toSorted()
}

/** Force the specimen root into (or out of) the Vapor set to match the app. */
function constrainRoot(
  files: readonly string[],
  appMode: AppMode,
  rootId: string | undefined,
  eligible: readonly Candidate[],
): readonly string[] {
  if (!rootId) return files
  const rootIsFlippable = eligible.some((c) => c.id === rootId)
  const wantVaporRoot = appMode === 'vapor-interop' || appMode === 'vapor-only'

  if (wantVaporRoot) {
    if (!rootIsFlippable) return files
    return files.includes(rootId) ? files : [...files, rootId].toSorted()
  }
  return files.filter((f) => f !== rootId)
}

function dirOf(id: string): string {
  const i = id.lastIndexOf('/')
  return i < 0 ? '' : id.slice(0, i)
}

function roundTo(value: number, digits: number): number {
  const f = 10 ** digits
  return Math.round(value * f) / f
}

/** Value-equality key, used to dedupe cases and to memoise shrinker probes. */
export function planKey(plan: FuzzPlan): string {
  return `${plan.specimenId}|${plan.appMode}|${plan.vaporFiles.join(',')}`
}

export function describePlan(plan: FuzzPlan): string {
  const files = plan.vaporFiles.length
  return `${plan.appMode} / ${plan.strategy} / ${files} vapor file${files === 1 ? '' : 's'}`
}

export function isAppMode(value: string): value is AppMode {
  return (APP_MODES as readonly string[]).includes(value)
}
