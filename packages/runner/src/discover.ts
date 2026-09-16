import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { analyzeSfc, type Candidate, type SfcAnalysis } from '@vapor-fuzz/core'
import type { SpecimenConfig, TargetDefinition } from '@vapor-fuzz/targets'
import type { ViteDevServer } from 'vite'
import { globFiles } from './glob.ts'
import { cleanModuleId, fromId, toId, WORKSPACE_ROOT } from './paths.ts'

const analysisCache = new Map<string, SfcAnalysis>()

export async function analyze(id: string): Promise<SfcAnalysis> {
  const cached = analysisCache.get(id)
  if (cached) return cached
  const abs = fromId(id)
  const source = await readFile(abs, 'utf8')
  const analysis = analyzeSfc(source, abs)
  analysisCache.set(id, analysis)
  return analysis
}

export interface SpecimenTargetPlan {
  readonly target: TargetDefinition
  readonly config: SpecimenConfig
  readonly targetDir: string
  /** Ids of files that can be mounted as the root of a case. */
  readonly specimens: readonly string[]
  /** Ids the mutator may flip. */
  readonly mutable: ReadonlySet<string>
  /** Specimens dropped because their root can never compile in Vapor Mode. */
  readonly skippedSpecimens: ReadonlyArray<{ id: string; reason: string }>
}

export async function planSpecimenTarget(target: TargetDefinition): Promise<SpecimenTargetPlan> {
  const config = target.specimen
  if (!config) throw new Error(`target "${target.id}" is not a specimen target`)

  const targetDir = path.join(WORKSPACE_ROOT, target.dir)

  const specimenFiles = await globFiles(targetDir, config.specimens, config.specimenExclude ?? [])
  const mutableFiles = await globFiles(targetDir, config.mutable, config.mutableExclude ?? [])

  const specimens: string[] = []
  const skippedSpecimens: Array<{ id: string; reason: string }> = []

  for (const abs of specimenFiles) {
    const id = toId(abs)
    if (!config.requireEligibleRoot) {
      specimens.push(id)
      continue
    }
    const analysis = await analyze(id)
    if (analysis.eligible) specimens.push(id)
    else skippedSpecimens.push({ id, reason: analysis.reason ?? 'not Vapor-eligible' })
  }

  return {
    target,
    config,
    targetDir,
    specimens,
    mutable: new Set(mutableFiles.map(toId)),
    skippedSpecimens,
  }
}

/**
 * Narrow the candidate set to components the specimen actually renders, and
 * give each one a real import depth.
 *
 * Globbing alone would hand `reka-ui` all 700-odd SFCs in the library for every
 * specimen, when a given demo touches a couple of dozen. Reading Vite's module
 * graph after a baseline render gives both the true set and the depth that
 * `boundary` and `clustered` need in order to mean anything.
 */
export async function candidatesFromGraph(
  server: ViteDevServer,
  entryModuleId: string,
  mutable: ReadonlySet<string>,
): Promise<Candidate[]> {
  const graph = resolveModuleGraph(server)
  if (!graph) return []

  const depths = new Map<string, number>()
  const entry = graph.getModuleById(entryModuleId)
  if (!entry) return []

  let frontier: ModuleLike[] = [entry]
  const visited = new Set<ModuleLike>([entry])
  let depth = 0

  while (frontier.length > 0 && depth < 64) {
    const next: ModuleLike[] = []
    for (const mod of frontier) {
      const modId = mod.id ? toId(cleanModuleId(mod.id)) : undefined
      if (modId && mutable.has(modId) && !depths.has(modId)) {
        // Depth 0 is the specimen itself: the entry imports it directly.
        depths.set(modId, Math.max(0, depth - 1))
      }
      for (const imported of mod.importedModules ?? []) {
        if (visited.has(imported)) continue
        visited.add(imported)
        next.push(imported)
      }
    }
    frontier = next
    depth++
  }

  const candidates: Candidate[] = []
  for (const [id, d] of [...depths].toSorted(([a], [b]) => a.localeCompare(b))) {
    const analysis = await analyze(id)
    candidates.push({
      id,
      absPath: fromId(id),
      kind: id.endsWith('.vue') ? 'sfc' : 'jsx',
      eligible: analysis.eligible,
      ...(analysis.reason ? { ineligibleReason: analysis.reason } : {}),
      authoredVapor: analysis.authoredVapor,
      depth: d,
    })
  }
  return candidates
}

interface ModuleLike {
  readonly id?: string | null
  readonly importedModules?: Iterable<ModuleLike>
}

interface ModuleGraphLike {
  getModuleById(id: string): ModuleLike | undefined
}

function resolveModuleGraph(server: ViteDevServer): ModuleGraphLike | undefined {
  const withEnvironments = server as unknown as {
    environments?: { client?: { moduleGraph?: ModuleGraphLike } }
    moduleGraph?: ModuleGraphLike
  }
  return withEnvironments.environments?.client?.moduleGraph ?? withEnvironments.moduleGraph
}
