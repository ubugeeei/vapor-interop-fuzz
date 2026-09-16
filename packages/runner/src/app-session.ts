import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { captureDom, collectActions, type CapturedDom, type PageAction } from '@vapor-fuzz/core'
import type { CaseObservation, DomSnapshot, FuzzPlan } from '@vapor-fuzz/core'
import type { AppConfig, TargetDefinition } from '@vapor-fuzz/targets'
import { chromium, type Browser, type Page } from 'playwright'
import { FUZZ_DIR, toId, WORKSPACE_ROOT } from './paths.ts'

/**
 * App-mode targets.
 *
 * Reka UI and Vuetify hand us mountable components, so the harness owns the
 * Vite server and can rewrite sources in a `transform` hook. A full application
 * does not: Nuxt owns `createApp`, the router, auto-imports and the build, and
 * a component pulled out of it will not render on its own.
 *
 * So for these targets the harness gets out of the way. It boots the target's
 * own dev server with two generated files injected through a Nuxt layer -- a
 * Vite plugin that performs the component-level Vapor switch, and a Nuxt plugin
 * that installs `vaporInteropPlugin` -- then drives the real application's
 * routes in the browser and diffs them against the unmutated run.
 *
 * The app-level axis is necessarily narrower here: Nuxt calls `createApp`
 * itself, so `createVaporApp` is not reachable and `AppConfig.appLevelSwitchable`
 * records that for the report. Targets whose repository owns `createApp`
 * (Misskey, Directus) do not have that limitation.
 */
export interface AppSessionOptions {
  readonly target: TargetDefinition
  readonly app: AppConfig
  readonly settleMs: number
  readonly maxActions: number
  readonly headless: boolean
  readonly startupTimeoutMs: number
  /** Stream the target's dev-server output; invaluable when it will not boot. */
  readonly verbose: boolean
}

export class AppSession {
  readonly #process: ChildProcess
  readonly #browser: Browser
  readonly #origin: string
  readonly #options: AppSessionOptions
  readonly #planFile: string

  private constructor(
    child: ChildProcess,
    browser: Browser,
    origin: string,
    options: AppSessionOptions,
    planFile: string,
  ) {
    this.#process = child
    this.#browser = browser
    this.#origin = origin
    this.#options = options
    this.#planFile = planFile
  }

  static async create(options: AppSessionOptions): Promise<AppSession> {
    const { target, app } = options
    const targetRoot = path.join(WORKSPACE_ROOT, target.dir, app.cwd ?? '.')

    // The layer has to live *inside* the submodule: the target's dev server is
    // its own `nuxt` binary resolving its own dependency graph, and Node only
    // finds those by walking up from the working directory. `.vapor-fuzz/` is
    // added to the submodule's local `info/exclude`, so the target's working
    // tree stays clean without editing anything it tracks.
    const workDir = path.join(targetRoot, LAYER_DIR)
    await mkdir(workDir, { recursive: true })
    await excludeFromGit(targetRoot, LAYER_DIR)

    const planFile = path.join(FUZZ_DIR, 'app', `${target.id}.plan.json`)
    await mkdir(path.dirname(planFile), { recursive: true })
    await writeFile(planFile, JSON.stringify({ vaporFiles: [] }), 'utf8')
    await writeLayer(workDir, targetRoot, planFile)

    const cwd = workDir
    const [command, ...args] = app.dev
    if (!command) throw new Error(`target "${target.id}" has an empty dev command`)

    const log: string[] = []
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Read by the generated layer; see `writeLayer`.
        VAPOR_FUZZ_PLAN: planFile,
        VAPOR_FUZZ_MUTABLE: app.mutable.join(','),
        NUXT_TELEMETRY_DISABLED: '1',
      },
    })

    const record = (chunk: Buffer): void => {
      log.push(chunk.toString())
      if (log.length > 200) log.splice(0, log.length - 200)
      if (options.verbose) process.stdout.write(chunk)
    }
    child.stdout?.on('data', record)
    child.stderr?.on('data', record)

    // Nuxt binds to `localhost`, which on a dual-stack machine may be ::1 while
    // 127.0.0.1 refuses the connection.
    const origin = `http://localhost:${app.port}`
    await waitForServer(origin, options.startupTimeoutMs, child, log)
    const browser = await chromium.launch({ headless: options.headless })
    return new AppSession(child, browser, origin, options, planFile)
  }

  /**
   * Apply a plan and render one route.
   *
   * The plan is handed to the running dev server through a file rather than a
   * restart: booting Nuxt again for every case would dominate the wall clock.
   */
  async run(
    plan: FuzzPlan,
    route: string,
    replay?: readonly PageAction[],
  ): Promise<{ observation: CaseObservation; actions: readonly PageAction[] }> {
    await writeFile(this.#planFile, JSON.stringify({ vaporFiles: plan.vaporFiles }), 'utf8')

    const context = await this.#browser.newContext({ reducedMotion: 'reduce' })
    const page = await context.newPage()
    const consoleErrors: string[] = []
    const consoleWarnings: string[] = []
    const pageErrors: string[] = []
    const snapshots: DomSnapshot[] = []
    let traceStoppedAt: string | undefined

    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
      else if (message.type() === 'warning') consoleWarnings.push(message.text())
    })
    page.on('pageerror', (error) => pageErrors.push(String(error.stack ?? error)))

    try {
      await page.goto(`${this.#origin}${route}`, { waitUntil: 'networkidle', timeout: 60_000 })
      await page.waitForTimeout(this.#options.settleMs)
      snapshots.push(await snapshot(page, 'initial'))

      const trace =
        replay ??
        (await page.evaluate(collectActions, {
          rootSelector: 'body',
          limit: this.#options.maxActions,
        }))

      for (const [index, action] of trace.entries()) {
        const locator = page.locator(action.selector).first()
        if ((await locator.count()) === 0) {
          traceStoppedAt = `action ${index} (${action.kind} ${action.selector})`
          break
        }
        try {
          if (action.kind === 'click') await locator.click({ timeout: 4000, force: true })
          else if (action.kind === 'type') await locator.fill(action.value ?? '', { timeout: 4000 })
          else if (action.kind === 'key') await locator.press(action.value ?? 'Enter')
          else await locator.hover({ timeout: 4000, force: true })
        } catch {
          traceStoppedAt = `action ${index} (${action.kind} ${action.selector})`
          break
        }
        await page.waitForTimeout(this.#options.settleMs)
        snapshots.push(await snapshot(page, `${index}:${action.kind}`))
      }

      return {
        observation: {
          mounted: true,
          snapshots,
          consoleErrors,
          consoleWarnings,
          pageErrors,
          ...(traceStoppedAt ? { traceStoppedAt } : {}),
        },
        actions: trace,
      }
    } catch (error) {
      return {
        observation: {
          mounted: false,
          snapshots,
          consoleErrors,
          consoleWarnings,
          pageErrors,
          buildError: String((error as Error)?.stack ?? error),
        },
        actions: replay ?? [],
      }
    } finally {
      await context.close().catch(() => {})
    }
  }

  async close(): Promise<void> {
    await this.#browser.close().catch(() => {})
    this.#process.kill('SIGTERM')
  }
}

async function snapshot(page: Page, label: string): Promise<DomSnapshot> {
  const captured: CapturedDom = await page.evaluate(captureDom, 'body')
  return { label, html: captured.html, text: captured.text }
}

/**
 * Write the Nuxt layer the target's dev server picks up.
 *
 * A layer is the one extension point that needs no edit inside the submodule:
 * the target repository stays byte-identical and `git status` stays clean, even
 * while its components are being recompiled in Vapor Mode.
 */
const LAYER_DIR = '.vapor-fuzz'

/**
 * Hide the generated layer from the submodule's git, without touching anything
 * the submodule tracks. `info/exclude` is local to the clone and never
 * committed, which is exactly the property we want.
 */
async function excludeFromGit(targetRoot: string, entry: string): Promise<void> {
  try {
    const dotGit = path.join(targetRoot, '.git')
    const stat = statSync(dotGit)
    // A submodule's `.git` is a file holding `gitdir: …`, not a directory.
    const gitDir = stat.isDirectory()
      ? dotGit
      : path.resolve(
          targetRoot,
          readFileSync(dotGit, 'utf8')
            .replace(/^gitdir:\s*/, '')
            .trim(),
        )

    const excludeFile = path.join(gitDir, 'info', 'exclude')
    await mkdir(path.dirname(excludeFile), { recursive: true })
    const current = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8') : ''
    if (current.split('\n').includes(entry)) return
    await writeFile(
      excludeFile,
      `${current}${current.endsWith('\n') || current === '' ? '' : '\n'}${entry}\n`,
    )
  } catch {
    // A missing or unusual git layout is not fatal; the run still works, the
    // target's `git status` just shows an untracked directory.
  }
}

async function writeLayer(workDir: string, targetRoot: string, planFile: string): Promise<void> {
  // `pnpm exec` refuses to run outside a package, so the layer needs a manifest
  // even though it declares no dependencies of its own -- it borrows the
  // target's, by sitting inside the target's directory tree.
  await writeFile(
    path.join(workDir, 'package.json'),
    `${JSON.stringify({ name: 'vapor-fuzz-layer', private: true, type: 'module' }, null, 2)}\n`,
    'utf8',
  )

  await writeFile(
    path.join(workDir, 'nuxt.config.ts'),
    `import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const PLAN_FILE = ${JSON.stringify(planFile)}
const WORKSPACE_ROOT = ${JSON.stringify(WORKSPACE_ROOT)}
const MUTABLE = (process.env.VAPOR_FUZZ_MUTABLE ?? '').split(',').filter(Boolean)

const VUE_ALIASES: Record<string, string> = Object.fromEntries(
  ['vue', '@vue/runtime-core', '@vue/runtime-dom', '@vue/runtime-vapor', '@vue/shared', '@vue/reactivity', '@vue/compiler-sfc', '@vue/compiler-core', '@vue/compiler-dom', '@vue/compiler-vapor']
    .map((name) => [name, path.join(WORKSPACE_ROOT, 'node_modules', name)])
    .filter(([, dir]) => {
      try {
        return readFileSync(path.join(dir as string, 'package.json'), 'utf8').length > 0
      } catch {
        return false
      }
    }),
)

/** Re-read on every transform so a case change needs no dev-server restart. */
function currentPlan(): Set<string> {
  try {
    return new Set(JSON.parse(readFileSync(PLAN_FILE, 'utf8')).vaporFiles ?? [])
  } catch {
    return new Set()
  }
}

const TARGET_ROOT = ${JSON.stringify(targetRoot)}
/** Nuxt 4 keeps application code in app/; older layouts use the root. */
const SRC_DIR = existsSync(path.join(TARGET_ROOT, 'app'))
  ? path.join(TARGET_ROOT, 'app')
  : TARGET_ROOT

export default defineNuxtConfig({
  extends: [TARGET_ROOT],
  telemetry: false,
  devtools: { enabled: false },
  /**
   * A Nuxt layer resolves \`~\` and \`@\` against the *consuming* app, so a target
   * whose server routes import \`~/server/utils/...\` would look for them next to
   * this generated config. Point every root alias back at the target.
   */
  srcDir: SRC_DIR,
  serverDir: path.join(TARGET_ROOT, 'server'),
  dir: { public: path.join(TARGET_ROOT, 'public'), modules: path.join(TARGET_ROOT, 'modules') },
  alias: {
    // Nuxt's convention: a single sigil is the source directory, a doubled one
    // is the project root.
    '~': SRC_DIR,
    '@': SRC_DIR,
    '~~': TARGET_ROOT,
    '@@': TARGET_ROOT,
  },
  vite: {
    resolve: {
      /**
       * Force the target onto the workspace's Vue.
       *
       * Every app-mode target pins a Vue version that predates Vapor Mode (Elk
       * ships 3.5.x), so without this the \`vapor\` block attribute compiles to
       * nothing and \`vaporInteropPlugin\` does not exist. Aliasing rather than
       * editing the submodule's package.json keeps its working tree clean.
       */
      alias: VUE_ALIASES,
      dedupe: Object.keys(VUE_ALIASES),
    },
    plugins: [
      {
        name: 'vapor-fuzz:component-mode',
        enforce: 'pre',
        async transform(code: string, id: string) {
          if (!id.endsWith('.vue') || id.includes('?')) return
          const rel = path.relative(WORKSPACE_ROOT, id).split(path.sep).join('/')
          if (!MUTABLE.some((glob) => matches(glob, rel))) return
          const { setVapor } = await import('@vapor-fuzz/core')
          const result = setVapor(code, id, currentPlan().has(rel))
          return result.changed ? { code: result.code, map: null } : undefined
        },
      },
    ],
  },
})

/** Minimal glob match: only \`**\` and \`*\` are used by target configs. */
function matches(glob: string, value: string): boolean {
  const pattern = glob
    .replace(/[.+^\${}()|[\\]\\\\]/g, '\\\\$&')
    .replace(/\\*\\*\\//g, '(?:.*/)?')
    .replace(/\\*/g, '[^/]*')
  return new RegExp(\`^\${pattern}$\`).test(value)
}
`,
    'utf8',
  )

  await mkdir(path.join(workDir, 'plugins'), { recursive: true })
  await writeFile(
    path.join(workDir, 'plugins', 'vapor-interop.client.ts'),
    `import { vaporInteropPlugin } from 'vue'

/**
 * Nuxt owns \`createApp\`, so the app-level axis here is limited to installing
 * the bridge on the virtual-DOM root it creates. \`createVaporApp\` is not
 * reachable without patching Nuxt itself.
 */
export default defineNuxtPlugin((nuxtApp) => {
  nuxtApp.vueApp.use(vaporInteropPlugin)
})
`,
    'utf8',
  )
}

async function waitForServer(
  origin: string,
  timeoutMs: number,
  child: ChildProcess,
  log: readonly string[],
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError = 'no response'
  let exited = false
  child.once('exit', (code) => {
    exited = true
    lastError = `dev server exited with code ${code}`
  })

  // `exited` is set by the 'exit' listener registered just above.
  // oxlint-disable-next-line eslint/no-unmodified-loop-condition
  while (Date.now() < deadline && !exited) {
    try {
      // Generous: a cold Nuxt start pre-bundles dependencies while serving the
      // first request, and a short abort just restarts that work.
      const response = await fetch(origin, { signal: AbortSignal.timeout(60_000) })
      if (response.ok || response.status < 500) return
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = String((error as Error)?.message ?? error)
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  child.kill('SIGTERM')
  const tail = log.join('').split('\n').filter(Boolean).slice(-25).join('\n')
  throw new Error(
    `dev server at ${origin} did not come up: ${lastError}` +
      (tail ? `\n--- dev server output ---\n${tail}` : ''),
  )
}

export { toId }
