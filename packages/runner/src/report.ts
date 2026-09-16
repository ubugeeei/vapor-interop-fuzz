import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describePlan, KNOWN_DIVERGENCES, type CaseResult, type Finding } from '@vapor-fuzz/core'
import { getTarget, TARGETS } from '@vapor-fuzz/targets'
import type { CampaignResult } from './campaign.ts'
import { REPORT_DIR } from './paths.ts'

export interface WrittenReport {
  readonly jsonPath: string
  readonly markdownPath: string
}

export async function writeReport(result: CampaignResult): Promise<WrittenReport> {
  await mkdir(REPORT_DIR, { recursive: true })
  const stamp = result.startedAt.replaceAll(':', '-').replace(/\..*$/, '')
  const base = `fuzz-${stamp}-seed${result.seed}`

  const jsonPath = path.join(REPORT_DIR, `${base}.json`)
  const markdownPath = path.join(REPORT_DIR, `${base}.md`)

  await writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  await writeFile(markdownPath, renderMarkdown(result), 'utf8')

  // A stable path for CI to upload and for humans to open.
  await writeFile(
    path.join(REPORT_DIR, 'latest.json'),
    `${JSON.stringify(result, null, 2)}\n`,
    'utf8',
  )
  await writeFile(path.join(REPORT_DIR, 'latest.md'), renderMarkdown(result), 'utf8')

  return { jsonPath, markdownPath }
}

export function isNovel(result: CaseResult): boolean {
  return result.status === 'fail' && result.findings.some((f) => !f.knownDivergence)
}

export function renderMarkdown(result: CampaignResult): string {
  const failed = result.results.filter((r) => r.status === 'fail')
  const failures = failed.filter(isNovel)
  const known = failed.filter((r) => !isNovel(r))
  const passes = result.results.filter((r) => r.status === 'pass')

  const lines: string[] = [
    '# Vapor interop fuzz report',
    '',
    `- seed: \`${result.seed}\` (replay with \`vp run fuzz:replay -- --seed ${result.seed}\`)`,
    `- started: ${result.startedAt}`,
    `- finished: ${result.finishedAt}`,
    `- cases: ${result.results.length} (${passes.length} passed, ${failures.length} with new findings, ${known.length} known-divergence only)`,
    '',
    '## Targets',
    '',
    '| target | specimens | cases | new findings | known only | dropped as flaky | note |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ]

  for (const target of result.targets) {
    const cases = target.specimens.reduce((n, s) => n + s.cases, 0)
    const fails = target.specimens.reduce((n, s) => n + s.failures, 0)
    const knownOnly = target.specimens.reduce((n, s) => n + s.knownOnly, 0)
    const flaky = target.specimens.reduce((n, s) => n + s.flaky, 0)
    const skipped = target.specimens.filter((s) => s.skipped)
    const note =
      target.skipped ?? (skipped.length > 0 ? `${skipped.length} specimen(s) skipped` : '')
    lines.push(
      `| \`${target.targetId}\` | ${target.specimens.length} | ${cases} | ${fails} | ${knownOnly} | ${flaky} | ${note} |`,
    )
  }

  lines.push('', '## New findings', '')
  if (failures.length === 0) {
    lines.push('No unexplained difference between the all-VDOM baseline and any mutant.', '')
  } else {
    for (const [index, failure] of failures.entries()) {
      lines.push(...renderFailure(index + 1, failure))
    }
  }

  if (known.length > 0) {
    lines.push('## Known divergences', '')
    const counts = new Map<string, number>()
    for (const failure of known) {
      for (const finding of failure.findings) {
        if (!finding.knownDivergence) continue
        counts.set(finding.knownDivergence, (counts.get(finding.knownDivergence) ?? 0) + 1)
      }
    }
    for (const [id, count] of counts) {
      const divergence = KNOWN_DIVERGENCES.find((d) => d.id === id)
      lines.push(`- **${id}** (${count} case(s)) — ${divergence?.title ?? 'unknown'}`)
      if (divergence) lines.push(`  ${divergence.explanation}`)
    }
    lines.push('')
  }

  const skippedSpecimens = result.targets.flatMap((t) =>
    t.specimens.filter((s) => s.skipped).map((s) => ({ target: t.targetId, ...s })),
  )
  const quarantined = result.targets.flatMap((t) =>
    t.specimens
      .filter((s) => s.volatileAttributes.length > 0)
      .map((s) => ({ target: t.targetId, ...s })),
  )
  if (quarantined.length > 0) {
    lines.push(
      '## Quarantined attributes',
      '',
      'Two identical renders disagreed on these, so they are masked before',
      'comparison. Differences carried by them cannot be detected.',
      '',
    )
    for (const s of quarantined) {
      lines.push(`- \`${s.specimenId}\` — ${s.volatileAttributes.join(', ')}`)
    }
    lines.push('')
  }

  if (skippedSpecimens.length > 0) {
    lines.push('## Skipped specimens', '')
    for (const s of skippedSpecimens) {
      lines.push(`- \`${s.specimenId}\` — ${s.skipped}`)
    }
    lines.push('')
  }

  return `${lines.join('\n')}\n`
}

function renderFailure(index: number, failure: CaseResult): string[] {
  const { plan } = failure
  const out: string[] = [
    `### ${index}. \`${plan.specimenId}\``,
    '',
    `- case: \`${plan.caseId}\``,
    `- shape: ${describePlan(plan)}`,
    `- seed: \`${plan.seed}\``,
    '',
  ]

  for (const finding of failure.findings) {
    out.push(`**${finding.kind}** — ${finding.summary}`, '')
    const minimal = finding.minimalPlan
    if (minimal) {
      out.push(
        `Minimal reproducer (${minimal.vaporFiles.length} Vapor file(s), app mode \`${minimal.appMode}\`):`,
        '',
        '```',
        ...minimal.vaporFiles.map((f) => `vapor: ${f}`),
        '```',
        '',
      )
    }
    out.push('```diff', truncate(finding.detail, 4000), '```', '')
  }
  return out
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (truncated)`
}

/** `vp run targets:licenses` */
export function renderLicenseTable(): string {
  const lines = [
    '| target | repo | licence | OSI | modification granted | default |',
    '| --- | --- | --- | --- | --- | --- |',
  ]
  for (const target of TARGETS) {
    lines.push(
      `| \`${target.id}\` | ${target.repo ? `[${target.repo}](https://github.com/${target.repo})` : '(in-repo)'} | ${target.license.id} | ${target.license.osiApproved ? 'yes' : '**no**'} | ${target.license.modificationGranted ? 'yes' : '**no**'} | ${target.enabledByDefault ? 'on' : 'off'} |`,
    )
  }
  return lines.join('\n')
}

export function summarizeFindings(findings: readonly Finding[]): string {
  const byKind = new Map<string, number>()
  for (const f of findings) byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1)
  return [...byKind].map(([kind, n]) => `${kind}×${n}`).join(', ')
}

export { getTarget }
