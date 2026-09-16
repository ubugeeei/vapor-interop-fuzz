import path from 'node:path'
import { setVapor } from '@vapor-fuzz/core'
import type { Plugin, ViteDevServer } from 'vite'
import { cleanModuleId, toId } from './paths.ts'

export const ENTRY_ID = 'virtual:vapor-fuzz/entry'
const RESOLVED_ENTRY_ID = `\0${ENTRY_ID}`

export interface EntrySpec {
  /** Absolute path of the component to mount. */
  readonly specimenPath: string
  /** `true` -> `createVaporApp`, `false` -> `createApp`. */
  readonly vaporRoot: boolean
  /** Whether `vaporInteropPlugin` is installed. */
  readonly interop: boolean
  /** Absolute path of an optional `{ install(app) }` module. */
  readonly setupPath?: string
  readonly cssPaths?: readonly string[]
}

/**
 * Mutable state shared between the runner and the Vite plugin.
 *
 * Keeping it mutable is what lets one dev server serve every case for a
 * specimen: the runner swaps the plan, invalidates the module graph, and
 * reloads, instead of paying Vite start-up and dependency pre-bundling costs
 * hundreds of times.
 */
export interface FuzzState {
  /** Workspace-relative ids that must compile in Vapor Mode. */
  vaporFiles: Set<string>
  /** Workspace-relative ids the mutator is allowed to touch at all. */
  mutable: Set<string>
  entry: EntrySpec
}

export function createFuzzState(entry: EntrySpec): FuzzState {
  return { vaporFiles: new Set(), mutable: new Set(), entry }
}

/**
 * The component-level switch.
 *
 * Runs before `@vitejs/plugin-vue` and rewrites the `vapor` block attribute on
 * the fly, so a mutation never touches a submodule's working tree: a run leaves
 * `git status` clean, and two cases can disagree about the same file without
 * any file system coordination.
 */
export function vaporFuzzPlugin(state: FuzzState, rewriteAlias: AliasRewrite[] = []): Plugin {
  return {
    name: 'vapor-fuzz:component-mode',
    enforce: 'pre',

    transform(code, id) {
      const clean = cleanModuleId(id)
      let next = rewriteAliasImports(code, clean, rewriteAlias)

      // Only the main `.vue` request matters for the Vapor switch: plugin-vue
      // parses the descriptor once here and serves every `?vue&type=…`
      // sub-request from that cache.
      if (clean.endsWith('.vue') && !id.includes('?')) {
        const rel = toId(clean)
        if (state.mutable.has(rel)) {
          const result = setVapor(next, id, state.vaporFiles.has(rel))
          if (result.changed) next = result.code
        }
      }

      return next === code ? undefined : { code: next, map: null }
    },
  }
}

export interface AliasRewrite {
  /** Specifier prefix, e.g. `@/`. */
  readonly prefix: string
  /** Absolute directory the prefix stands for. */
  readonly dir: string
}

const REWRITABLE = /\.(?:vue|ts|tsx|mts|js|jsx|mjs)$/

/** Rewrite `'@/x/y'` to a relative specifier so every resolver agrees. */
export function rewriteAliasImports(
  code: string,
  id: string,
  rewrites: readonly AliasRewrite[],
): string {
  if (rewrites.length === 0 || !REWRITABLE.test(id)) return code
  const fromDir = path.dirname(id)

  let out = code
  for (const { prefix, dir } of rewrites) {
    if (!out.includes(prefix)) continue
    const pattern = new RegExp(`(['"])${escapeRegExp(prefix)}([^'"\n]*)\\1`, 'g')
    out = out.replace(pattern, (_match, quote: string, rest: string) => {
      const absolute = path.join(dir, rest)
      let relative = path.relative(fromDir, absolute).replaceAll(path.sep, '/')
      if (!relative.startsWith('.')) relative = `./${relative}`
      return `${quote}${relative}${quote}`
    })
  }
  return out
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The app-level switch, emitted as a virtual entry module. */
export function fuzzEntryPlugin(state: FuzzState): Plugin {
  return {
    name: 'vapor-fuzz:entry',

    resolveId(id) {
      return id === ENTRY_ID ? RESOLVED_ENTRY_ID : undefined
    },

    load(id) {
      return id === RESOLVED_ENTRY_ID ? renderEntry(state.entry) : undefined
    },
  }
}

export function renderEntry(entry: EntrySpec): string {
  const create = entry.vaporRoot ? 'createVaporApp' : 'createApp'
  const imports = [
    `import { ${create}${entry.interop ? ', vaporInteropPlugin' : ''} } from 'vue'`,
    `import Specimen from ${JSON.stringify(entry.specimenPath)}`,
  ]
  if (entry.setupPath) imports.push(`import setup from ${JSON.stringify(entry.setupPath)}`)
  for (const css of entry.cssPaths ?? []) imports.push(`import ${JSON.stringify(css)}`)

  return `${imports.join('\n')}

const bus = (globalThis.__VAPOR_FUZZ__ = {
  mounted: false,
  failed: false,
  errors: [],
  warnings: [],
})

const app = ${create}(Specimen)

// Vue's own hooks are far more reliable than scraping the console: they fire
// for handled errors too, and they are not subject to devtools formatting.
app.config.errorHandler = (err, _instance, info) => {
  bus.errors.push('[errorHandler:' + info + '] ' + String((err && err.stack) || err))
}
app.config.warnHandler = (msg, _instance, trace) => {
  bus.warnings.push('[warnHandler] ' + msg + (trace ? '\\n' + trace : ''))
}

${entry.interop ? 'app.use(vaporInteropPlugin)\n' : ''}${entry.setupPath ? 'setup?.install?.(app)\n' : ''}
try {
  app.mount('#app')
  bus.mounted = true
} catch (err) {
  bus.failed = true
  bus.errors.push('[mount] ' + String((err && err.stack) || err))
}
`
}

/**
 * Vite renamed the module graph when environments landed, and the shim is
 * deprecated. Try the new location first and fall back, so the runner works on
 * both plain Vite and the Vite+ core build.
 */
export function invalidateAll(server: ViteDevServer): void {
  const environments = (
    server as unknown as {
      environments?: Record<string, { moduleGraph?: { invalidateAll?: () => void } }>
    }
  ).environments
  const graphs = [
    environments?.client?.moduleGraph,
    environments?.ssr?.moduleGraph,
    (server as unknown as { moduleGraph?: { invalidateAll?: () => void } }).moduleGraph,
  ]
  for (const graph of graphs) graph?.invalidateAll?.()
}
