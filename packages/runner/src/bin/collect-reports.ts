#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { CampaignResult } from '../campaign.ts'
import { isNovel } from '../report.ts'

/**
 * Fold the per-target artifacts of a nightly matrix into one issue body.
 *
 * Prints nothing when every campaign came back clean, which is what lets the
 * workflow decide whether to open an issue at all: a nightly that files "no
 * findings" every morning is a nightly people mute.
 */
const root = process.argv[2]
if (!root) {
  process.stderr.write('usage: collect-reports.ts <artifacts-dir>\n')
  process.exit(2)
}

const reports = await findLatestReports(root)
const sections: string[] = []
let total = 0

for (const file of reports) {
  const campaign = JSON.parse(await readFile(file, 'utf8')) as CampaignResult
  const novel = campaign.results.filter(isNovel)
  if (novel.length === 0) continue
  total += novel.length

  const targetIds = [...new Set(novel.map((r) => r.plan.targetId))].join(', ')
  sections.push(`## ${targetIds} — ${novel.length} new finding(s) (seed \`${campaign.seed}\`)\n`)

  for (const result of novel.slice(0, 10)) {
    const minimal = result.findings.find((f) => f.minimalPlan)?.minimalPlan
    sections.push(
      `- \`${result.plan.specimenId}\` — ${result.findings[0]?.summary ?? 'finding'}`,
      `  - app mode: \`${result.plan.appMode}\`, seed \`${result.plan.seed}\``,
      minimal
        ? `  - minimal: ${minimal.vaporFiles.length} Vapor file(s)${
            minimal.vaporFiles.length <= 3 ? ` — ${minimal.vaporFiles.join(', ')}` : ''
          }`
        : '  - not shrunk',
    )
  }
  if (novel.length > 10) sections.push(`- …and ${novel.length - 10} more; see the artifacts.`)
  sections.push('')
}

if (total === 0) process.exit(0)

process.stdout.write(
  [
    `${total} new finding(s) across ${reports.length} campaign(s).`,
    '',
    'Replay any of them with:',
    '',
    '```bash',
    'vp run fuzz:replay -- --target <target> --seed <seed>',
    '```',
    '',
    ...sections,
  ].join('\n'),
)

async function findLatestReports(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name === 'latest.json') {
      out.push(path.join(entry.parentPath ?? dir, entry.name))
    }
  }
  return out.toSorted()
}
