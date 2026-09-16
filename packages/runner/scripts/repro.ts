/**
 * Manual reproducer / stability probe.
 *
 *   node packages/runner/scripts/repro.ts <target> <specimen> [options] [vaporFile…]
 *
 *     --app-mode <mode>   app mode for the second run (default: vdom-interop)
 *     --actions <n>       interactions to replay (default: 0)
 *     --settle <ms>       pause after each render (default: 120)
 *     --show-tree         print both normalised trees in full
 *
 * With no vapor files and the default app mode this is a determinism probe:
 * it renders the same tree twice and diffs the two runs.
 */
import { parseArgs } from 'node:util'
import { compareObservations, renderDiff, type FuzzPlan } from '@vapor-fuzz/core'
import { getTarget } from '@vapor-fuzz/targets'
import { planSpecimenTarget } from '../src/discover.ts'
import { SpecimenSession } from '../src/session.ts'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'app-mode': { type: 'string', default: 'vdom-interop' },
    actions: { type: 'string', default: '0' },
    settle: { type: 'string', default: '120' },
    'show-tree': { type: 'boolean', default: false },
  },
})

const [targetId, specimenId, ...vaporFiles] = positionals
if (!targetId || !specimenId) {
  process.stderr.write('usage: repro.ts <target> <specimen> [options] [vaporFile…]\n')
  process.exit(2)
}

const targetPlan = await planSpecimenTarget(getTarget(targetId))
const session = await SpecimenSession.create({
  plan: targetPlan,
  specimenId,
  port: 5299,
  settleMs: Number(values.settle),
  maxActions: Number(values.actions),
  headless: true,
})

const make = (files: string[], mode: string): FuzzPlan => ({
  seed: 0,
  caseId: 'repro',
  targetId,
  specimenId,
  appMode: mode as FuzzPlan['appMode'],
  strategy: 'uniform',
  density: 0,
  vaporFiles: files,
})

try {
  const basePlan = make([], 'vdom-interop')
  const first = await session.run(basePlan)
  const secondPlan = make(vaporFiles, values['app-mode'] as string)
  const second = await session.run(secondPlan, first.actions)

  process.stdout.write(
    `baseline  mounted=${first.observation.mounted} snapshots=${first.observation.snapshots.length} ` +
      `actions=${first.actions.length}\n` +
      `candidate mounted=${second.observation.mounted} snapshots=${second.observation.snapshots.length} ` +
      `(${values['app-mode']}, ${vaporFiles.length} vapor file(s))\n\n`,
  )

  for (const error of second.observation.consoleErrors) {
    process.stdout.write(`ERR  ${error.split('\n')[0]}\n`)
  }

  const findings = compareObservations(first.observation, second.observation, secondPlan)
  if (findings.length === 0) {
    process.stdout.write('no difference\n')
  }
  for (const finding of findings) {
    process.stdout.write(
      `\n## ${finding.kind}${finding.knownDivergence ? ` [${finding.knownDivergence}]` : ''}\n` +
        `${finding.summary}\n${finding.detail}\n`,
    )
  }

  if (values['show-tree']) {
    for (const [index, snapshot] of first.observation.snapshots.entries()) {
      const other = second.observation.snapshots[index]
      process.stdout.write(`\n=== snapshot ${snapshot.label} ===\n`)
      process.stdout.write(other ? renderDiff(snapshot.html, other.html) : snapshot.html)
      process.stdout.write('\n')
    }
  }
} finally {
  await session.close()
}
