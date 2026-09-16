#!/usr/bin/env node
import { spawn } from 'node:child_process'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { randomSeed } from '@vapor-fuzz/core'
import { defaultTargets, getTarget, TARGETS } from '@vapor-fuzz/targets'
import { runCampaign, type CampaignEvent, type CampaignOptions } from '../campaign.ts'
import { planSpecimenTarget } from '../discover.ts'
import { WORKSPACE_ROOT } from '../paths.ts'
import { isNovel, renderLicenseTable, summarizeFindings, writeReport } from '../report.ts'

const USAGE = `vapor-fuzz <command> [options]

Commands
  run                 Fuzz Vapor <-> virtual DOM interop and write a report
  replay --seed N     Re-run a previous campaign exactly
  install-target <id> Install a target submodule's own dependencies (app mode)
  list                List targets and the specimens discovered for each
  licenses            Print the target licence matrix (non-zero if unclear)

Options
  --target <id>       Repeatable. Defaults to every target enabled by default.
  --cases <n>         Mutant cases per specimen (default 10)
  --specimens <n>     Max specimens per target (default 4)
  --seed <n>          Campaign seed (default: random, always printed)
  --no-shrink         Skip delta debugging of failures
  --shrink-probes <n> Max renders spent reducing one finding (default 60)
  --headed            Show the browser
  --verbose           Stream an app-mode target's dev-server output
  --settle <ms>       Pause after each render before snapshotting (default 80)
  --actions <n>       Max interactions replayed per case (default 6)
  --port <n>          First dev-server port (default 5190)
`

/**
 * `vp run fuzz -- --seed 1` forwards a literal `--` to the task, and Node's
 * `parseArgs` treats that as "stop parsing options", which would silently turn
 * every documented flag into a positional. Drop the separator first.
 */
const argv = process.argv
  .slice(2)
  .filter((arg, index, all) => arg !== '--' || all.indexOf('--') !== index)

const { values, positionals } = parseArgs({
  args: argv,
  allowPositionals: true,
  options: {
    target: { type: 'string', multiple: true },
    cases: { type: 'string' },
    specimens: { type: 'string' },
    seed: { type: 'string' },
    shrink: { type: 'boolean', default: true },
    'shrink-probes': { type: 'string' },
    headed: { type: 'boolean', default: false },
    verbose: { type: 'boolean', default: false },
    settle: { type: 'string' },
    actions: { type: 'string' },
    port: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
})

const command = positionals[0] ?? 'run'

if (values.help) {
  process.stdout.write(USAGE)
  process.exit(0)
}

switch (command) {
  case 'run':
  case 'replay':
    await commandRun()
    break
  case 'install-target':
    await commandInstallTarget()
    break
  case 'list':
    await commandList()
    break
  case 'licenses':
    commandLicenses()
    break
  default:
    process.stderr.write(`unknown command "${command}"\n\n${USAGE}`)
    process.exit(2)
}

async function commandRun(): Promise<void> {
  const seed = values.seed ? Number(values.seed) : randomSeed()
  if (!Number.isFinite(seed)) {
    process.stderr.write('--seed must be a number\n')
    process.exit(2)
  }
  if (command === 'replay' && !values.seed) {
    process.stderr.write('replay requires --seed\n')
    process.exit(2)
  }

  const targetIds = values.target?.length ? values.target : defaultTargets().map((t) => t.id)

  const options: CampaignOptions = {
    targetIds,
    casesPerSpecimen: numeric(values.cases, 10),
    maxSpecimens: numeric(values.specimens, 4),
    seed,
    shrink: values.shrink !== false,
    shrinkProbes: numeric(values['shrink-probes'], 60),
    headless: !values.headed,
    settleMs: numeric(values.settle, 80),
    maxActions: numeric(values.actions, 6),
    basePort: numeric(values.port, 5190),
    verbose: values.verbose === true,
    onEvent: report,
  }

  process.stdout.write(`vapor-interop-fuzz — seed ${seed}\n`)
  process.stdout.write(`targets: ${targetIds.join(', ')}\n\n`)

  const result = await runCampaign(options)
  const written = await writeReport(result)

  const failed = result.results.filter((r) => r.status === 'fail')
  const failures = failed.filter(isNovel)
  const known = failed.length - failures.length
  process.stdout.write(
    `\n${result.results.length} case(s): ${failures.length} with new findings, ` +
      `${known} explained by a known divergence\n` +
      `report: ${written.markdownPath}\n`,
  )
  if (failures.length > 0) {
    process.stdout.write(`\nreplay this campaign with: --seed ${seed}\n`)
    process.exit(1)
  }
}

async function commandInstallTarget(): Promise<void> {
  const ids = positionals.slice(1)
  if (ids.length === 0) {
    process.stderr.write(
      'install-target needs at least one target id; app-mode targets are ' +
        `${TARGETS.filter((t) => t.mode === 'app')
          .map((t) => t.id)
          .join(', ')}\n`,
    )
    process.exit(2)
  }

  for (const id of ids) {
    const target = getTarget(id)
    if (!target.requires.includes('install')) {
      process.stdout.write(`${id}: no install needed\n`)
      continue
    }
    const cwd = path.join(WORKSPACE_ROOT, target.dir)
    process.stdout.write(`${id}: installing in ${target.dir}…\n`)
    const code = await run('pnpm', ['install', '--frozen-lockfile'], cwd)
    if (code !== 0) {
      process.stderr.write(`${id}: install failed with exit code ${code}\n`)
      process.exit(code ?? 1)
    }
  }
}

function run(bin: string, args: readonly string[], cwd: string): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(bin, [...args], { cwd, stdio: 'inherit' })
    child.on('exit', resolve)
  })
}

async function commandList(): Promise<void> {
  for (const target of TARGETS) {
    const flags = [target.enabledByDefault ? 'default' : 'opt-in', ...target.requires].join(', ')
    process.stdout.write(`\n${target.id}  [${flags}]  ${target.license.id}\n`)
    process.stdout.write(`  ${target.title}\n`)
    if (target.mode !== 'specimen' || !target.specimen) {
      process.stdout.write("  mode: app (driven through the target's own dev server)\n")
      continue
    }
    try {
      const plan = await planSpecimenTarget(target)
      process.stdout.write(
        `  specimens: ${plan.specimens.length} mountable, ` +
          `${plan.skippedSpecimens.length} not Vapor-eligible, ` +
          `${plan.mutable.size} mutable file(s)\n`,
      )
      for (const specimen of plan.specimens.slice(0, 3)) {
        process.stdout.write(`    - ${specimen}\n`)
      }
      if (plan.specimens.length > 3) {
        process.stdout.write(`    … and ${plan.specimens.length - 3} more\n`)
      }
    } catch (error) {
      process.stdout.write(`  unavailable: ${String((error as Error)?.message ?? error)}\n`)
    }
  }
  process.stdout.write('\n')
}

function commandLicenses(): void {
  process.stdout.write(`${renderLicenseTable()}\n\n`)
  const blocked = TARGETS.filter((t) => !t.license.modificationGranted)
  if (blocked.length > 0) {
    process.stderr.write(
      `these targets do not grant modification rights: ${blocked.map((t) => t.id).join(', ')}\n`,
    )
    process.exit(1)
  }
  const nonOsi = TARGETS.filter((t) => !t.license.osiApproved)
  if (nonOsi.length > 0) {
    process.stdout.write(
      `note: ${nonOsi.map((t) => `${t.id} (${t.license.id})`).join(', ')} ` +
        'are source-available rather than OSI-approved, and are opt-in for that reason.\n',
    )
  }
}

function report(event: CampaignEvent): void {
  switch (event.type) {
    case 'target-start':
      process.stdout.write(`▸ ${event.target.id}: ${event.specimens} specimen(s)\n`)
      break
    case 'target-skip':
      process.stdout.write(`▹ ${event.target.id}: skipped — ${event.reason}\n`)
      break
    case 'specimen-start':
      process.stdout.write(
        `  · ${event.specimenId} (${event.eligible}/${event.candidates} flippable)\n`,
      )
      break
    case 'specimen-skip':
      process.stdout.write(`  · ${event.specimenId} — skipped: ${event.reason}\n`)
      break
    case 'volatile-attributes':
      process.stdout.write(
        `      quarantined volatile attribute(s): ${event.attributes.join(', ')}\n`,
      )
      break
    case 'trace-truncated':
      process.stdout.write(
        `      replaying ${event.kept} of ${event.recorded} recorded interaction(s); ` +
          'the rest are not reproducible even without a mutation\n',
      )
      break
    case 'flaky':
      process.stdout.write(
        `    ? ${event.plan.appMode}/${event.plan.strategy} ` +
          `${event.plan.vaporFiles.length} vapor — did not reproduce, dropped\n`,
      )
      break
    case 'shrink':
      process.stdout.write(
        `      shrank ${event.from} → ${event.to} vapor file(s) in ${event.probes} probe(s)\n`,
      )
      break
    case 'case': {
      const { plan, status, findings } = event.result
      if (status === 'fail') {
        const novel = findings.some((f) => !f.knownDivergence)
        process.stdout.write(
          `    ${novel ? '✗' : '~'} ${plan.appMode}/${plan.strategy} ` +
            `${plan.vaporFiles.length} vapor — ${summarizeFindings(findings)}\n`,
        )
      } else if (status === 'skipped') {
        process.stdout.write(`    - ${plan.appMode}/${plan.strategy} skipped\n`)
      }
      break
    }
  }
}

function numeric(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}
