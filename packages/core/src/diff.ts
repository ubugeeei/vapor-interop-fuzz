import { classifyDom, classifyErrors } from './classify.ts'
import type { CaseObservation, Finding, FuzzPlan } from './types.ts'

/**
 * Turn "baseline vs mutant" into findings.
 *
 * The baseline is always the same tree rendered entirely by the virtual DOM,
 * so any difference here is by definition a Vapor interop difference.
 */
export function compareObservations(
  baseline: CaseObservation,
  mutant: CaseObservation,
  plan: FuzzPlan,
): Finding[] {
  return tagKnownCause(collectFindings(baseline, mutant, plan))
}

/**
 * When every new error shares one known cause, the DOM differences that come
 * with it are downstream of that crash; tag them all rather than reporting the
 * wreckage as separate unexplained findings.
 */
function tagKnownCause(findings: readonly Finding[]): Finding[] {
  const errorDetails = findings.filter((f) => f.kind === 'runtime-error').map((f) => f.detail)
  const cause = classifyErrors(errorDetails)
  if (!cause) return [...findings]
  return findings.map((f) => ({ ...f, knownDivergence: f.knownDivergence ?? cause.id }))
}

function collectFindings(
  baseline: CaseObservation,
  mutant: CaseObservation,
  plan: FuzzPlan,
): Finding[] {
  const findings: Finding[] = []

  if (mutant.buildError) {
    findings.push({
      kind: 'compile-error',
      summary: 'the mutated build failed while the all-VDOM build succeeded',
      detail: mutant.buildError,
    })
    // A build that never ran has no DOM to compare; stop here.
    return findings
  }

  if (baseline.mounted && !mutant.mounted) {
    // The mutant never mounted. Its empty DOM would diff against everything, so
    // report the failure itself and nothing else.
    return [
      {
        kind: 'runtime-error',
        summary: `app.mount() threw in ${plan.appMode}`,
        detail: [...mutant.consoleErrors, ...mutant.pageErrors].join('\n---\n'),
      },
    ]
  }

  const newPageErrors = subtractErrors(mutant.pageErrors, baseline.pageErrors)
  if (newPageErrors.length > 0) {
    findings.push({
      kind: 'runtime-error',
      summary: `${newPageErrors.length} uncaught error(s) not present in the baseline`,
      detail: newPageErrors.join('\n---\n'),
    })
  }

  const newConsoleErrors = subtractErrors(mutant.consoleErrors, baseline.consoleErrors)
  if (newConsoleErrors.length > 0) {
    findings.push({
      kind: 'runtime-error',
      summary: `${newConsoleErrors.length} console error(s) not present in the baseline`,
      detail: newConsoleErrors.join('\n---\n'),
    })
  }

  const steps = Math.min(baseline.snapshots.length, mutant.snapshots.length)
  for (let i = 0; i < steps; i++) {
    const a = baseline.snapshots[i]
    const b = mutant.snapshots[i]
    if (!a || !b) continue

    if (a.html !== b.html) {
      const known = classifyDom(a.html, b.html)
      findings.push({
        kind: 'dom-mismatch',
        summary: known
          ? `DOM differs at step "${a.label}" (${known.title})`
          : `DOM differs at step "${a.label}"`,
        detail: renderDiff(a.html, b.html),
        ...(known ? { knownDivergence: known.id } : {}),
      })
      // One structural mismatch poisons every later step; reporting all of them
      // would bury the actual first divergence.
      break
    }
    if (a.text !== b.text) {
      findings.push({
        kind: 'text-mismatch',
        summary: `rendered text differs at step "${a.label}"`,
        detail: renderDiff(a.text, b.text),
      })
      break
    }
  }

  if (mutant.traceStoppedAt && findings.length === 0) {
    findings.push({
      kind: 'dom-mismatch',
      summary: 'the recorded interaction trace could not be replayed on the mutant',
      detail:
        `Replay stopped at ${mutant.traceStoppedAt} under ${plan.appMode}: the element ` +
        'the baseline interacted with does not exist in this render, even though ' +
        'every snapshot up to that point matched.',
    })
  }

  return findings
}

/**
 * A stable fingerprint of what went wrong, used by the shrinker.
 *
 * Reducing on "still fails somehow" is not good enough: a smaller plan can
 * easily fail for a *different* reason, and the search then walks away from the
 * bug it was sent to minimise -- which is how a crash in `PinInputRoot` ends up
 * attributed to `MenuSubContent`. Fingerprinting on the normalised error
 * messages (falling back to the set of finding kinds when there are none) keeps
 * every reduction step anchored to the original symptom.
 */
export function findingSignature(findings: readonly Finding[]): string {
  const errors = findings
    .filter((f) => f.kind === 'runtime-error' || f.kind === 'compile-error')
    .map((f) => normalizeErrorText(firstMeaningfulLine(f.detail)))
    .filter(Boolean)
    .toSorted()

  if (errors.length > 0) return `err:${[...new Set(errors)].join('|')}`
  return `kind:${[...new Set(findings.map((f) => f.kind))].toSorted().join('|')}`
}

/** The message line, skipping the stack frames that follow it. */
function firstMeaningfulLine(detail: string): string {
  for (const line of detail.split('\n')) {
    const trimmed = line.trim()
    if (trimmed && !trimmed.startsWith('at ') && trimmed !== '---') return trimmed
  }
  return detail.slice(0, 200)
}

/**
 * Error text carries absolute paths, ports and line numbers that shift between
 * two dev servers. Compare on the shape of the message, not its coordinates.
 */
export function normalizeErrorText(text: string): string {
  return text
    .replace(/https?:\/\/[^\s)"']+/g, '<url>')
    .replace(/(?:\/[\w.@+-]+)+\.(?:ts|js|vue|mjs|cjs)/g, '<path>')
    .replace(/:\d+:\d+/g, ':<pos>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * New errors only -- keyed on the *message*, deliberately not the stack.
 *
 * The same failure genuinely produces different frames under the two runtimes
 * (`setupStatefulComponent` in runtime-core vs `setupComponent` in
 * runtime-vapor), so including the stack in the key makes every pre-existing
 * error look new. Vuetify's docs examples rely on auto-imports and therefore
 * throw `ReferenceError` in *both* runs: comparing on the stack reported that
 * as a Vapor regression.
 */
function subtractErrors(mutant: readonly string[], baseline: readonly string[]): string[] {
  const key = (text: string) => normalizeErrorText(firstMeaningfulLine(text))
  const known = new Set(baseline.map(key))
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of mutant) {
    const k = key(raw)
    if (known.has(k) || seen.has(k)) continue
    seen.add(k)
    out.push(raw)
  }
  return out
}

const DIFF_CONTEXT = 2
const DIFF_MAX_LINES = 80
const DIFF_MAX_INPUT = 4000

/**
 * Line diff over the longest common subsequence.
 *
 * A first-divergence/last-divergence window is much cheaper but badly
 * misleading here: one changed attribute early in the tree and one late makes
 * the whole span between them look deleted, which reads like "the subtree
 * vanished" when the truth is "two attributes differ".
 */
export function renderDiff(expected: string, actual: string): string {
  const a = expected.split('\n')
  const b = actual.split('\n')

  const ops = a.length * b.length > DIFF_MAX_INPUT * DIFF_MAX_INPUT ? coarseOps(a, b) : lcsOps(a, b)

  const interesting = ops
    .map((op, index) => ({ op, index }))
    .filter(({ op }) => op.kind !== 'same')
    .map(({ index }) => index)

  if (interesting.length === 0) return '(no line-level difference)'

  const keep = new Set<number>()
  for (const index of interesting) {
    for (let i = index - DIFF_CONTEXT; i <= index + DIFF_CONTEXT; i++) {
      if (i >= 0 && i < ops.length) keep.add(i)
    }
  }

  const lines: string[] = []
  let previous = -1
  let changed = 0
  for (const index of [...keep].toSorted((x, y) => x - y)) {
    if (lines.length >= DIFF_MAX_LINES) {
      lines.push(`… (${interesting.length - changed} more changed line(s) not shown)`)
      break
    }
    if (previous >= 0 && index !== previous + 1) lines.push('@@')
    const op = ops[index]!
    if (op.kind === 'same') lines.push(`  ${op.text}`)
    else if (op.kind === 'del') {
      lines.push(`- ${op.text}`)
      changed++
    } else {
      lines.push(`+ ${op.text}`)
      changed++
    }
    previous = index
  }
  return lines.join('\n')
}

interface DiffOp {
  readonly kind: 'same' | 'del' | 'add'
  readonly text: string
}

function lcsOps(a: readonly string[], b: readonly string[]): DiffOp[] {
  const n = a.length
  const m = b.length
  // table[i][j] = LCS length of a[i…] and b[j…]
  const table: number[][] = Array.from({ length: n + 1 }, () =>
    Array.from({ length: m + 1 }, () => 0),
  )
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] =
        a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
    }
  }

  const ops: DiffOp[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'same', text: a[i]! })
      i++
      j++
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      ops.push({ kind: 'del', text: a[i]! })
      i++
    } else {
      ops.push({ kind: 'add', text: b[j]! })
      j++
    }
  }
  while (i < n) ops.push({ kind: 'del', text: a[i++]! })
  while (j < m) ops.push({ kind: 'add', text: b[j++]! })
  return ops
}

/** Fallback for pathologically large trees: common prefix/suffix only. */
function coarseOps(a: readonly string[], b: readonly string[]): DiffOp[] {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length - 1
  let endB = b.length - 1
  while (endA > start && endB > start && a[endA] === b[endB]) {
    endA--
    endB--
  }
  return [
    ...a.slice(0, start).map((text): DiffOp => ({ kind: 'same', text })),
    ...a.slice(start, endA + 1).map((text): DiffOp => ({ kind: 'del', text })),
    ...b.slice(start, endB + 1).map((text): DiffOp => ({ kind: 'add', text })),
    ...a.slice(endA + 1).map((text): DiffOp => ({ kind: 'same', text })),
  ]
}
