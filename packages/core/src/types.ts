/**
 * The two axes of the fuzzer.
 *
 * `AppMode` is the *application* level switch: which runtime owns the root of
 * the tree, and whether the interop bridge is installed at all.
 *
 * `vaporFiles` in {@link FuzzPlan} is the *component* level switch: the set of
 * SFCs that get compiled in Vapor Mode for this particular case.
 */
export type AppMode =
  /** `createApp()` + `app.use(vaporInteropPlugin)` -- VDOM root hosting Vapor children. */
  | 'vdom-interop'
  /** `createVaporApp()` + `app.use(vaporInteropPlugin)` -- Vapor root hosting VDOM children. */
  | 'vapor-interop'
  /** `createApp()` with no bridge. Any Vapor child is expected to fail loudly. */
  | 'vdom-only'
  /** `createVaporApp()` with no bridge. Any VDOM child is expected to fail loudly. */
  | 'vapor-only'

export const APP_MODES: readonly AppMode[] = [
  'vdom-interop',
  'vapor-interop',
  'vdom-only',
  'vapor-only',
]

/** Mode that renders the reference tree every mutant is compared against. */
export const BASELINE_APP_MODE: AppMode = 'vdom-interop'

export type MutationStrategy =
  /** Each eligible component independently flips with probability `density`. */
  | 'uniform'
  /** Flip whole subtrees, producing long vapor/vdom runs instead of noise. */
  | 'clustered'
  /** Alternate as aggressively as possible to maximise interop boundaries. */
  | 'boundary'
  /** Only the specimen's own root component. */
  | 'root-only'
  /** Everything eligible. */
  | 'all'
  /** Nothing. Used for the baseline and for control cases. */
  | 'none'

export const MUTATION_STRATEGIES: readonly MutationStrategy[] = [
  'uniform',
  'clustered',
  'boundary',
  'root-only',
  'all',
  'none',
]

/** A `.vue` (or `.tsx`) file that the mutator is allowed to flip. */
export interface Candidate {
  /** Workspace-relative, POSIX-separated. Stable across machines. */
  readonly id: string
  /** Absolute path on this machine. */
  readonly absPath: string
  /** `sfc` files flip via the `vapor` block attribute, `jsx` files via plugin routing. */
  readonly kind: 'sfc' | 'jsx'
  /** False when the file cannot be compiled in Vapor Mode at all. */
  readonly eligible: boolean
  /** Why it is not eligible, for the report. */
  readonly ineligibleReason?: string
  /** True when the file already opts into Vapor in its own source. */
  readonly authoredVapor: boolean
  /** Rough nesting depth under the specimen root; drives `clustered`/`boundary`. */
  readonly depth: number
}

export interface FuzzPlan {
  readonly seed: number
  readonly caseId: string
  readonly targetId: string
  readonly specimenId: string
  readonly appMode: AppMode
  readonly strategy: MutationStrategy
  readonly density: number
  /** Candidate ids compiled in Vapor Mode. Sorted, so plans compare by value. */
  readonly vaporFiles: readonly string[]
}

export interface DomSnapshot {
  readonly label: string
  /** Normalised outerHTML of the mount root. */
  readonly html: string
  /** Normalised textContent, kept separately so text-only drift is easy to spot. */
  readonly text: string
}

export type ActionKind = 'click' | 'type' | 'key' | 'hover'

export interface Action {
  readonly kind: ActionKind
  /** Structural selector computed from the baseline DOM, replayed verbatim. */
  readonly selector: string
  readonly value?: string
}

export interface CaseObservation {
  /** False when `app.mount()` threw: the DOM diff is then meaningless noise. */
  readonly mounted: boolean
  readonly snapshots: readonly DomSnapshot[]
  readonly consoleErrors: readonly string[]
  readonly consoleWarnings: readonly string[]
  readonly pageErrors: readonly string[]
  /** Build/compile failure text, when the case never made it to the browser. */
  readonly buildError?: string
  /**
   * Set when the recorded interaction trace could not be replayed to the end.
   * This is a *consequence* of a DOM divergence, not an error of its own, so it
   * is kept out of the error streams where it would defeat classification.
   */
  readonly traceStoppedAt?: string
}

export type FindingKind =
  | 'dom-mismatch'
  | 'text-mismatch'
  | 'runtime-error'
  | 'compile-error'
  | 'baseline-unstable'

export interface Finding {
  readonly kind: FindingKind
  readonly summary: string
  readonly detail: string
  /** Id of a {@link KnownDivergence} that fully explains this mismatch. */
  readonly knownDivergence?: string
  /** Set once the shrinker has reduced the plan. */
  readonly minimalPlan?: FuzzPlan
}

export interface CaseResult {
  readonly plan: FuzzPlan
  readonly status: 'pass' | 'fail' | 'skipped'
  readonly durationMs: number
  readonly findings: readonly Finding[]
  readonly skipReason?: string
}
