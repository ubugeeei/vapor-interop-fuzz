import { existsSync } from 'node:fs'
import path from 'node:path'
import {
  baselinePlan,
  compareObservations,
  detectVolatileAttributes,
  findingSignature,
  generatePlan,
  maskAttributes,
  shrinkPlan,
  type Candidate,
  type CaseObservation,
  type CaseResult,
  type Finding,
  type FuzzPlan,
  type PageAction,
} from '@vapor-fuzz/core'
import { getTarget, type TargetDefinition } from '@vapor-fuzz/targets'
import { AppSession } from './app-session.ts'
import {
  analyze,
  candidatesFromGraph,
  planSpecimenTarget,
  type SpecimenTargetPlan,
} from './discover.ts'
import { globFiles } from './glob.ts'
import { fromId, toId, WORKSPACE_ROOT } from './paths.ts'
import { SpecimenSession, type RunOutcome } from './session.ts'

export interface CampaignOptions {
  readonly targetIds: readonly string[]
  /** Cases per specimen, on top of the two baseline renders. */
  readonly casesPerSpecimen: number
  /** Cap on specimens per target; the subset is chosen deterministically. */
  readonly maxSpecimens: number
  readonly seed: number
  readonly shrink: boolean
  /** Upper bound on renders spent reducing a single finding. */
  readonly shrinkProbes: number
  /** Stream an app-mode target's dev-server output. */
  readonly verbose: boolean
  readonly headless: boolean
  readonly settleMs: number
  readonly maxActions: number
  readonly basePort: number
  readonly onEvent?: (event: CampaignEvent) => void
}

export type CampaignEvent =
  | { type: 'target-start'; target: TargetDefinition; specimens: number }
  | { type: 'target-skip'; target: TargetDefinition; reason: string }
  | { type: 'specimen-start'; specimenId: string; candidates: number; eligible: number }
  | { type: 'specimen-skip'; specimenId: string; reason: string }
  | { type: 'case'; result: CaseResult }
  | { type: 'shrink'; from: number; to: number; probes: number }
  | { type: 'volatile-attributes'; specimenId: string; attributes: readonly string[] }
  | { type: 'flaky'; specimenId: string; plan: FuzzPlan }
  | { type: 'trace-truncated'; specimenId: string; kept: number; recorded: number }

export interface SpecimenSummary {
  readonly specimenId: string
  readonly candidates: number
  readonly eligibleCandidates: number
  readonly cases: number
  /** Cases with at least one unclassified finding. */
  readonly failures: number
  /** Cases whose every finding is a documented known divergence. */
  readonly knownOnly: number
  /** Attributes quarantined because two identical renders disagreed on them. */
  readonly volatileAttributes: readonly string[]
  /** Cases that failed once but did not reproduce, and were therefore dropped. */
  readonly flaky: number
  readonly skipped?: string
}

export interface TargetSummary {
  readonly targetId: string
  readonly specimens: readonly SpecimenSummary[]
  readonly skipped?: string
}

export interface CampaignResult {
  readonly seed: number
  readonly startedAt: string
  readonly finishedAt: string
  readonly options: Omit<CampaignOptions, 'onEvent'>
  readonly targets: readonly TargetSummary[]
  readonly results: readonly CaseResult[]
}

export async function runCampaign(options: CampaignOptions): Promise<CampaignResult> {
  const startedAt = new Date().toISOString()
  const results: CaseResult[] = []
  const targets: TargetSummary[] = []

  let portOffset = 0
  for (const targetId of options.targetIds) {
    const target = getTarget(targetId)

    if (target.mode === 'app') {
      options.onEvent?.({ type: 'target-start', target, specimens: target.app?.routes.length ?? 0 })
      const summaries = await runAppTarget(target, options, (result) => {
        results.push(result)
        options.onEvent?.({ type: 'case', result })
      })
      if (summaries.skipped) {
        options.onEvent?.({ type: 'target-skip', target, reason: summaries.skipped })
      }
      targets.push({
        targetId,
        specimens: summaries.specimens,
        ...(summaries.skipped ? { skipped: summaries.skipped } : {}),
      })
      continue
    }

    let plan: SpecimenTargetPlan
    try {
      plan = await planSpecimenTarget(target)
    } catch (error) {
      const reason = String((error as Error)?.message ?? error)
      options.onEvent?.({ type: 'target-skip', target, reason })
      targets.push({ targetId, specimens: [], skipped: reason })
      continue
    }

    if (plan.specimens.length === 0) {
      const reason = target.repo
        ? `no mountable specimens found under ${target.dir} -- is the submodule checked out?`
        : 'no mountable specimens found'
      options.onEvent?.({ type: 'target-skip', target, reason })
      targets.push({ targetId, specimens: [], skipped: reason })
      continue
    }

    const specimens = pickSpecimens(plan.specimens, options.maxSpecimens, options.seed)
    options.onEvent?.({ type: 'target-start', target, specimens: specimens.length })

    const summaries: SpecimenSummary[] = []
    for (const specimenId of specimens) {
      const summary = await runSpecimen({
        plan,
        specimenId,
        options,
        port: options.basePort + portOffset++,
        collect: (result) => {
          results.push(result)
          options.onEvent?.({ type: 'case', result })
        },
      })
      summaries.push(summary)
    }
    targets.push({ targetId, specimens: summaries })
  }

  const { onEvent: _onEvent, ...plainOptions } = options
  return {
    seed: options.seed,
    startedAt,
    finishedAt: new Date().toISOString(),
    options: plainOptions,
    targets,
    results,
  }
}

/**
 * Drive a target's own application.
 *
 * Every route is treated the way a specimen is: render it unmutated to get a
 * reference tree and an interaction trace, then replay that trace against
 * mutated renders. The component-level switch is applied inside the target's
 * own dev server through a generated Nuxt layer; see `app-session.ts` for why
 * the app-level switch is narrower here.
 */
async function runAppTarget(
  target: TargetDefinition,
  options: CampaignOptions,
  collect: (result: CaseResult) => void,
): Promise<{ specimens: SpecimenSummary[]; skipped?: string }> {
  const app = target.app
  if (!app) return { specimens: [], skipped: 'no app configuration' }

  const targetDir = path.join(WORKSPACE_ROOT, target.dir)
  if (!existsSync(path.join(targetDir, 'node_modules'))) {
    return {
      specimens: [],
      skipped: `${target.dir} has no node_modules -- run \`vp run targets:install -- ${target.id}\` first`,
    }
  }

  const mutableFiles = await globFiles(targetDir, app.mutable, app.mutableExclude ?? [])
  const mutable = new Set(mutableFiles.map(toId))

  let session: AppSession
  try {
    session = await AppSession.create({
      target,
      app,
      settleMs: options.settleMs,
      maxActions: options.maxActions,
      headless: options.headless,
      startupTimeoutMs: 180_000,
      verbose: options.verbose,
    })
  } catch (error) {
    return { specimens: [], skipped: String((error as Error)?.message ?? error) }
  }

  const summaries: SpecimenSummary[] = []
  try {
    for (const route of app.routes) {
      const specimenId = `${target.id}${route}`
      const base = baselinePlan({ targetId: target.id, specimenId, candidates: [] })

      const first = await session.run(base, route)
      if (!first.observation.mounted) {
        const reason = `route did not render: ${String(first.observation.buildError).split('\n')[0]}`
        options.onEvent?.({ type: 'specimen-skip', specimenId, reason })
        summaries.push(emptySummary(specimenId, reason))
        continue
      }

      const second = await session.run(base, route, first.actions)
      const volatileAttributes = collectVolatileAttributes(first, second)
      const baseline = mask(first.observation, volatileAttributes)
      const stableSteps = countStableSteps(baseline, mask(second.observation, volatileAttributes))
      if (stableSteps === 0) {
        const reason = 'route is not deterministic between two identical renders'
        options.onEvent?.({ type: 'specimen-skip', specimenId, reason })
        summaries.push(emptySummary(specimenId, reason))
        continue
      }

      const actions = first.actions.slice(0, stableSteps - 1)
      const candidates: Candidate[] = []
      for (const id of [...mutable].toSorted()) {
        const analysis = await analyze(id)
        candidates.push({
          id,
          absPath: fromId(id),
          kind: 'sfc',
          eligible: analysis.eligible,
          ...(analysis.reason ? { ineligibleReason: analysis.reason } : {}),
          authoredVapor: analysis.authoredVapor,
          depth: id.split('/').length,
        })
      }

      options.onEvent?.({
        type: 'specimen-start',
        specimenId,
        candidates: candidates.length,
        eligible: candidates.filter((c) => c.eligible).length,
      })

      let failures = 0
      let knownOnly = 0
      let flaky = 0
      let cases = 0

      for (let i = 0; i < options.casesPerSpecimen; i++) {
        const casePlan = generatePlan({
          seed: mixSeed(options.seed, specimenId, i),
          targetId: target.id,
          specimenId,
          candidates,
          // Nuxt creates the app, so the Vapor-root shapes are unreachable.
          ...(app.appLevelSwitchable ? {} : { appMode: 'vdom-interop' as const }),
        })

        const startedAt = Date.now()
        const outcome = await session.run(casePlan, route, actions)
        const findings = compareObservations(
          truncate(baseline, stableSteps),
          truncate(mask(outcome.observation, volatileAttributes), stableSteps),
          casePlan,
        )
        cases++

        if (findings.length === 0) {
          collect({
            plan: casePlan,
            status: 'pass',
            durationMs: Date.now() - startedAt,
            findings: [],
          })
          continue
        }

        const again = await session.run(casePlan, route, actions)
        const confirm = compareObservations(
          truncate(baseline, stableSteps),
          truncate(mask(again.observation, volatileAttributes), stableSteps),
          casePlan,
        )
        if (confirm.length === 0 || findingSignature(confirm) !== findingSignature(findings)) {
          flaky++
          options.onEvent?.({ type: 'flaky', specimenId, plan: casePlan })
          continue
        }

        if (findings.some((f) => !f.knownDivergence)) failures++
        else knownOnly++
        collect({
          plan: casePlan,
          status: 'fail',
          durationMs: Date.now() - startedAt,
          findings,
        })
      }

      summaries.push({
        specimenId,
        candidates: candidates.length,
        eligibleCandidates: candidates.filter((c) => c.eligible).length,
        cases,
        failures,
        knownOnly,
        volatileAttributes,
        flaky,
      })
    }
  } finally {
    await session.close()
  }

  return { specimens: summaries }
}

interface RunSpecimenArgs {
  readonly plan: SpecimenTargetPlan
  readonly specimenId: string
  readonly options: CampaignOptions
  readonly port: number
  readonly collect: (result: CaseResult) => void
}

async function runSpecimen(args: RunSpecimenArgs): Promise<SpecimenSummary> {
  const { plan, specimenId, options, port, collect } = args
  const session = await SpecimenSession.create({
    plan,
    specimenId,
    port,
    settleMs: options.settleMs,
    maxActions: options.maxActions,
    headless: options.headless,
  })

  try {
    const base = baselinePlan({
      targetId: plan.target.id,
      specimenId,
      candidates: [],
    })

    const first = await session.run(base)
    if (first.observation.buildError) {
      const reason = `baseline failed to render: ${firstLine(first.observation.buildError)}`
      options.onEvent?.({ type: 'specimen-skip', specimenId, reason })
      return emptySummary(specimenId, reason)
    }

    // Render the baseline twice. Anything that differs between two identical
    // renders would otherwise show up as an endless stream of phantom interop
    // findings.
    const second = await session.run(base, first.actions)

    // …but some of that difference is a timestamp or a measured offset written
    // into an attribute, which is worth quarantining rather than throwing the
    // whole specimen away. `detectVolatileAttributes` only offers a mask when
    // the two trees are otherwise identical, so a real difference still stops
    // the specimen here.
    const volatileAttributes = collectVolatileAttributes(first, second)
    const baselineObservation = mask(first.observation, volatileAttributes)

    const secondObservation = mask(second.observation, volatileAttributes)

    // How far into the recorded trace do two identical runs still agree?
    //
    // Discarding the whole specimen at the first disagreement throws away its
    // initial render too, which is usually both stable and the most valuable
    // comparison there is. Truncating instead keeps that coverage and costs
    // only the interactions that were never going to be comparable.
    const stableSteps = countStableSteps(baselineObservation, secondObservation)
    if (stableSteps === 0) {
      const reason =
        'baseline is not deterministic (the initial render differs between two identical runs)'
      options.onEvent?.({ type: 'specimen-skip', specimenId, reason })
      return emptySummary(specimenId, reason)
    }

    const actions = first.actions.slice(0, stableSteps - 1)
    const baseline = truncate(baselineObservation, stableSteps)
    if (actions.length < first.actions.length) {
      options.onEvent?.({
        type: 'trace-truncated',
        specimenId,
        kept: actions.length,
        recorded: first.actions.length,
      })
    }
    if (volatileAttributes.length > 0) {
      options.onEvent?.({ type: 'volatile-attributes', specimenId, attributes: volatileAttributes })
    }

    const candidates = await candidatesFromGraph(
      session.server,
      '\0virtual:vapor-fuzz/entry',
      plan.mutable,
    )
    const withRoot = await ensureRoot(candidates, specimenId, plan.mutable)
    const eligible = withRoot.filter((c) => c.eligible)

    options.onEvent?.({
      type: 'specimen-start',
      specimenId,
      candidates: withRoot.length,
      eligible: eligible.length,
    })

    if (eligible.length === 0) {
      const reason = "no Vapor-eligible component in this specimen's module graph"
      options.onEvent?.({ type: 'specimen-skip', specimenId, reason })
      return emptySummary(specimenId, reason)
    }

    let failures = 0
    let knownOnly = 0
    let flaky = 0
    let cases = 0
    // Buffered: a specimen that turns out to be nondeterministic must not leave
    // half a campaign's worth of phantom findings behind it.
    const buffered: CaseResult[] = []

    for (let i = 0; i < options.casesPerSpecimen; i++) {
      const caseSeed = mixSeed(options.seed, specimenId, i)
      const casePlan = generatePlan({
        seed: caseSeed,
        targetId: plan.target.id,
        specimenId,
        candidates: withRoot,
        rootId: specimenId,
        treeFullyMutable: plan.config.treeFullyMutable ?? false,
        // The first case of every specimen is the control: plain virtual DOM,
        // no bridge, nothing flipped. It must reproduce the baseline exactly.
        // Two identical baseline renders do not catch a specimen that is only
        // *intermittently* nondeterministic -- a clock-dependent calendar, say
        // -- and one such specimen can otherwise manufacture a whole report.
        ...(i === 0 ? { shape: 'pure-vdom' as const } : {}),
      })

      const startedAt = Date.now()
      const outcome = await session.run(casePlan, actions)
      const findings = compareObservations(
        baseline,
        truncate(mask(outcome.observation, volatileAttributes), stableSteps),
        casePlan,
      )
      cases++

      if (findings.length === 0) {
        buffered.push({
          plan: casePlan,
          status: 'pass',
          durationMs: Date.now() - startedAt,
          findings: [],
        })
        continue
      }

      // Confirm before believing it. A component library with JS-driven
      // teardown timers produces the odd one-off difference that has nothing to
      // do with the mutation, and an unconfirmed finding costs a reader far
      // more than the one extra render costs the campaign.
      const confirmed = await reproduces({
        session,
        baseline,
        plan: casePlan,
        actions,
        volatileAttributes,
        stableSteps,
        signature: findingSignature(findings),
      })
      if (!confirmed) {
        flaky++
        options.onEvent?.({ type: 'flaky', specimenId, plan: casePlan })
        continue
      }

      if (i === 0) {
        const reason = `control case diverged from the baseline (${findings[0]?.summary}) -- specimen is not deterministic`
        options.onEvent?.({ type: 'specimen-skip', specimenId, reason })
        return emptySummary(specimenId, reason)
      }

      const novel = findings.some((f) => !f.knownDivergence)
      if (novel) failures++
      else knownOnly++

      // Shrinking is the expensive part of a campaign, so spend it only on
      // findings nobody has already explained.
      const enriched =
        options.shrink && novel
          ? await shrinkFindings({
              session,
              baseline,
              plan: casePlan,
              findings,
              actions,
              options,
              volatileAttributes,
              stableSteps,
            })
          : findings

      buffered.push({
        plan: casePlan,
        status: 'fail',
        durationMs: Date.now() - startedAt,
        findings: enriched,
      })
    }

    for (const result of buffered) collect(result)

    return {
      specimenId,
      candidates: withRoot.length,
      eligibleCandidates: eligible.length,
      cases,
      failures,
      knownOnly,
      volatileAttributes,
      flaky,
    }
  } finally {
    await session.close()
  }
}

interface ShrinkArgs {
  readonly session: SpecimenSession
  readonly baseline: CaseObservation
  readonly plan: FuzzPlan
  readonly findings: readonly Finding[]
  readonly actions: readonly PageAction[]
  readonly options: CampaignOptions
  readonly volatileAttributes: readonly string[]
  readonly stableSteps: number
}

async function shrinkFindings(args: ShrinkArgs): Promise<Finding[]> {
  const { session, baseline, plan, findings, actions, options, volatileAttributes, stableSteps } =
    args
  if (plan.vaporFiles.length <= 1) return [...findings]

  const signature = findingSignature(findings)
  const result = await shrinkPlan(
    plan,
    async (candidate) => {
      const outcome = await session.run(candidate, actions)
      const probe = compareObservations(
        baseline,
        truncate(mask(outcome.observation, volatileAttributes), stableSteps),
        candidate,
      )
      if (probe.length === 0) return false
      // Only accept a reduction that reproduces the *same* symptom. Accepting
      // any failure lets the search drift onto a different bug and then blame
      // the wrong component for it.
      return findingSignature(probe) === signature
    },
    // ddmin needs roughly `4·log2(n)` probes to isolate a single culprit, so a
    // flat budget silently stops reducing on the large plans that need it most.
    {
      maxProbes: Math.min(
        options.shrinkProbes,
        12 + 4 * Math.ceil(Math.log2(plan.vaporFiles.length + 1)),
      ),
    },
  )

  options.onEvent?.({
    type: 'shrink',
    from: plan.vaporFiles.length,
    to: result.plan.vaporFiles.length,
    probes: result.probes,
  })

  return findings.map((finding) => ({ ...finding, minimalPlan: result.plan }))
}

/**
 * The module graph will not see the specimen itself when its only importer is
 * the virtual entry and Vite resolved it before the plugin ran, so make sure
 * the root is always a candidate at depth 0.
 */
async function ensureRoot(
  candidates: readonly Candidate[],
  specimenId: string,
  mutable: ReadonlySet<string>,
): Promise<Candidate[]> {
  if (candidates.some((c) => c.id === specimenId) || !mutable.has(specimenId)) {
    return [...candidates]
  }
  const analysis = await analyze(specimenId)
  return [
    {
      id: specimenId,
      absPath: fromId(specimenId),
      kind: specimenId.endsWith('.vue') ? 'sfc' : 'jsx',
      eligible: analysis.eligible,
      ...(analysis.reason ? { ineligibleReason: analysis.reason } : {}),
      authoredVapor: analysis.authoredVapor,
      depth: 0,
    },
    ...candidates,
  ]
}

function emptySummary(specimenId: string, reason: string): SpecimenSummary {
  return {
    specimenId,
    candidates: 0,
    eligibleCandidates: 0,
    cases: 0,
    failures: 0,
    knownOnly: 0,
    volatileAttributes: [],
    flaky: 0,
    skipped: reason,
  }
}

/** Render the same plan again and check it fails the same way. */
async function reproduces(args: {
  session: SpecimenSession
  baseline: CaseObservation
  plan: FuzzPlan
  actions: readonly PageAction[]
  volatileAttributes: readonly string[]
  stableSteps: number
  signature: string
}): Promise<boolean> {
  const outcome = await args.session.run(args.plan, args.actions)
  const findings = compareObservations(
    args.baseline,
    truncate(mask(outcome.observation, args.volatileAttributes), args.stableSteps),
    args.plan,
  )
  return findings.length > 0 && findingSignature(findings) === args.signature
}

/** Number of leading snapshots two runs of the same plan agree on. */
function countStableSteps(a: CaseObservation, b: CaseObservation): number {
  if (!a.mounted || !b.mounted) return 0
  const steps = Math.min(a.snapshots.length, b.snapshots.length)
  let stable = 0
  while (stable < steps) {
    const left = a.snapshots[stable]
    const right = b.snapshots[stable]
    if (!left || !right || left.html !== right.html || left.text !== right.text) break
    stable++
  }
  return stable
}

function truncate(observation: CaseObservation, steps: number): CaseObservation {
  return observation.snapshots.length <= steps
    ? observation
    : { ...observation, snapshots: observation.snapshots.slice(0, steps) }
}

function collectVolatileAttributes(a: RunOutcome, b: RunOutcome): string[] {
  const names = new Set<string>()
  const steps = Math.min(a.observation.snapshots.length, b.observation.snapshots.length)
  for (let i = 0; i < steps; i++) {
    const left = a.observation.snapshots[i]
    const right = b.observation.snapshots[i]
    if (!left || !right || left.html === right.html) continue
    for (const name of detectVolatileAttributes(left.html, right.html)) names.add(name)
  }
  return [...names].toSorted()
}

function mask(observation: CaseObservation, names: readonly string[]): CaseObservation {
  if (names.length === 0) return observation
  return {
    ...observation,
    snapshots: observation.snapshots.map((s) => ({ ...s, html: maskAttributes(s.html, names) })),
  }
}

/** Deterministic, evenly spread subset -- not just the first N alphabetically. */
function pickSpecimens(all: readonly string[], max: number, seed: number): string[] {
  if (all.length <= max) return [...all]
  const stride = all.length / max
  const offset = seed % Math.max(1, Math.floor(stride))
  const out: string[] = []
  for (let i = 0; i < max; i++) {
    const index = Math.min(all.length - 1, Math.floor(i * stride) + offset)
    const pick = all[index]
    if (pick && !out.includes(pick)) out.push(pick)
  }
  return out
}

function mixSeed(seed: number, specimenId: string, index: number): number {
  let h = seed ^ 0x9e3779b9
  for (let i = 0; i < specimenId.length; i++) {
    h = Math.imul(h ^ specimenId.charCodeAt(i), 0x01000193) >>> 0
  }
  return Math.imul(h ^ index, 0x85ebca6b) >>> 0 || 1
}

function firstLine(text: string): string {
  return text.split('\n')[0] ?? text
}
