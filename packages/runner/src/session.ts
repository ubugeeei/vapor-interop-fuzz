import fs from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import vue from '@vitejs/plugin-vue'
import { createServer, type InlineConfig, type Plugin, type ViteDevServer } from 'vite'
import { captureDom, collectActions, type CapturedDom, type PageAction } from '@vapor-fuzz/core'
import type { CaseObservation, DomSnapshot, FuzzPlan } from '@vapor-fuzz/core'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { registerCompilerTypeScript, vueCompiler } from './compiler-ts.ts'
import type { SpecimenTargetPlan } from './discover.ts'
import { cleanModuleId, FUZZ_DIR, fromId, toId, WORKSPACE_ROOT } from './paths.ts'
import {
  createFuzzState,
  ENTRY_ID,
  fuzzEntryPlugin,
  invalidateAll,
  vaporFuzzPlugin,
  type AliasRewrite,
  type FuzzState,
} from './vite-plugin.ts'

/**
 * A target's own `tsconfig.json` usually extends a preset (`@vue/tsconfig`,
 * `@nuxt/tsconfig`, …) that only exists after that submodule has been
 * installed. Vite discovers the nearest tsconfig per file, so without an
 * override every specimen would fail to transform. Pinning one neutral config
 * keeps the harness independent of each target's dependency graph.
 */
const HARNESS_TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: 'esnext',
      module: 'esnext',
      moduleResolution: 'bundler',
      jsx: 'preserve',
      jsxImportSource: 'vue',
      verbatimModuleSyntax: false,
      useDefineForClassFields: true,
      experimentalDecorators: true,
    },
  },
  null,
  2,
)

/** Long enough for a cold dependency scan, short enough to fail fast. */
const MOUNT_TIMEOUT_MS = 20_000

/** Upper bound on waiting for the DOM to stop changing after a render. */
const SETTLE_MAX_MS = 1_500

/**
 * File system access for `@vue/compiler-sfc`'s cross-file type resolution.
 *
 * `defineProps<T>()` where `T` extends an imported interface makes the SFC
 * compiler read other files itself. @vitejs/plugin-vue does not pass an `fs`,
 * so compiler-sfc falls back to `ts.sys` -- which the native TypeScript 7
 * package does not expose. Without this, every component in a library that
 * shares a `PrimitiveProps`-style base type fails with "Failed to resolve
 * extends base type", and the fuzzer would never get past the first render.
 */
const COMPILER_FS = {
  fileExists(file: string): boolean {
    try {
      return fs.statSync(file).isFile()
    } catch {
      return false
    }
  },
  readFile(file: string): string | undefined {
    try {
      return fs.readFileSync(file, 'utf8')
    } catch {
      return undefined
    }
  },
  realpath(file: string): string {
    try {
      return fs.realpathSync(file)
    } catch {
      return file
    }
  },
}

/**
 * Collapse animation *durations* -- not animation *behaviour*.
 *
 * Differential comparison needs two renders of the same tree to agree, and a
 * component library with ripples and slide transitions will not agree on when a
 * frame lands. Vue still adds and removes `v-enter-from` / `v-leave-to` exactly
 * as it would otherwise, so the Vapor transition implementation is still under
 * test; only the wall-clock window in which the classes are observable shrinks
 * to nothing. Without this, every Vuetify specimen is discarded as unstable.
 */
const FREEZE_ANIMATIONS_CSS = `
*, *::before, *::after {
  transition-duration: 0s !important;
  transition-delay: 0s !important;
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  caret-color: transparent !important;
}
`

const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>vapor-interop-fuzz</title>
    <style>${FREEZE_ANIMATIONS_CSS}</style>
  </head>
  <body>
    <div id="app"></div>
    <script type="module">
      import ${JSON.stringify(ENTRY_ID)}
    </script>
  </body>
</html>
`

export interface SessionOptions {
  readonly plan: SpecimenTargetPlan
  readonly specimenId: string
  readonly port: number
  /** Milliseconds to let effects, transitions and microtasks settle. */
  readonly settleMs: number
  readonly maxActions: number
  readonly headless: boolean
}

/**
 * One Vite dev server + one browser, reused across every case for a specimen.
 *
 * Restarting Vite per case would dominate the wall clock (dependency
 * pre-bundling for a target like Reka UI is seconds, and a campaign is
 * hundreds of cases). Instead the plan lives in mutable plugin state: swap it,
 * invalidate the module graph, open a fresh browser context, reload.
 */
export class SpecimenSession {
  readonly #server: ViteDevServer
  readonly #browser: Browser
  readonly #state: FuzzState
  readonly #url: string
  readonly #options: SessionOptions
  #caseCounter = 0

  private constructor(
    server: ViteDevServer,
    browser: Browser,
    state: FuzzState,
    url: string,
    options: SessionOptions,
  ) {
    this.#server = server
    this.#browser = browser
    this.#state = state
    this.#url = url
    this.#options = options
  }

  static async create(options: SessionOptions): Promise<SpecimenSession> {
    await registerCompilerTypeScript()
    const { plan, specimenId } = options
    const root = path.join(FUZZ_DIR, 'work', plan.target.id)
    await mkdir(root, { recursive: true })
    await writeFile(path.join(root, 'index.html'), INDEX_HTML, 'utf8')
    const tsconfigPath = path.join(root, 'harness.tsconfig.json')
    await writeFile(tsconfigPath, `${HARNESS_TSCONFIG}\n`, 'utf8')

    const state = createFuzzState({
      specimenPath: fromId(specimenId),
      vaporRoot: false,
      interop: true,
      ...(plan.config.setupModule ? { setupPath: fromId(plan.config.setupModule) } : {}),
      ...(plan.config.css ? { cssPaths: plan.config.css.map(fromId) } : {}),
    })
    state.mutable = new Set(plan.mutable)

    // The predicate closes over `state`, which the runner mutates between
    // cases -- so a JSX target's compiler routing follows the plan the same way
    // the SFC rewrite does, with no dev-server restart.
    const extraPlugins = await loadExtraPlugins(plan, (id) =>
      state.vaporFiles.has(toId(cleanModuleId(id))),
    )
    const rewriteAlias: AliasRewrite[] = Object.entries(plan.config.rewriteAlias ?? {}).map(
      ([prefix, dir]) => ({ prefix, dir: fromId(dir) }),
    )

    const config: InlineConfig = {
      root,
      configFile: false,
      tsconfig: tsconfigPath,
      logLevel: 'error',
      appType: 'spa',
      clearScreen: false,
      plugins: [
        vaporFuzzPlugin(state, rewriteAlias),
        fuzzEntryPlugin(state),
        vue({ compiler: vueCompiler(), script: { fs: COMPILER_FS } }),
        ...extraPlugins,
      ],
      resolve: {
        alias: Object.entries(plan.config.alias ?? {}).map(([find, replacement]) => ({
          find,
          replacement: fromId(replacement),
        })),
        // A target and the harness must never end up with two copies of Vue:
        // the interop bridge is module-level state, and two copies would fail
        // in ways that look exactly like the bugs we are hunting.
        dedupe: ['vue', '@vue/runtime-core', '@vue/runtime-dom', '@vue/runtime-vapor'],
      },
      server: {
        port: options.port,
        strictPort: true,
        host: '127.0.0.1',
        fs: { allow: [WORKSPACE_ROOT], strict: false },
        watch: { ignored: ['**/*'] },
        hmr: false,
      },
      optimizeDeps: {
        // Pre-bundling would hide mutated sources behind a cached bundle.
        exclude: ['vue', ...Object.keys(plan.config.alias ?? {})],
      },
    }

    const server = await createServer(config)
    await server.listen()
    const browser = await chromium.launch({ headless: options.headless })

    return new SpecimenSession(
      server,
      browser,
      state,
      `http://127.0.0.1:${options.port}/index.html`,
      options,
    )
  }

  get state(): FuzzState {
    return this.#state
  }

  get server(): ViteDevServer {
    return this.#server
  }

  /** Render one plan and observe the result. `actions` replays a recorded trace. */
  async run(plan: FuzzPlan, actions?: readonly PageAction[]): Promise<RunOutcome> {
    this.#applyPlan(plan)
    invalidateAll(this.#server)

    // A fresh context per case, so no HTTP cache or module cache can leak the
    // previous plan's compiled output into this one.
    const context = await this.#browser.newContext({ reducedMotion: 'reduce' })
    try {
      return await this.#observe(context, actions)
    } finally {
      await context.close()
    }
  }

  async close(): Promise<void> {
    await this.#browser.close().catch(() => {})
    await this.#server.close().catch(() => {})
  }

  #applyPlan(plan: FuzzPlan): void {
    this.#state.vaporFiles = new Set(plan.vaporFiles)
    this.#state.entry = {
      ...this.#state.entry,
      specimenPath: fromId(plan.specimenId),
      vaporRoot: plan.appMode === 'vapor-interop' || plan.appMode === 'vapor-only',
      interop: plan.appMode === 'vapor-interop' || plan.appMode === 'vdom-interop',
    }
  }

  async #observe(context: BrowserContext, replay?: readonly PageAction[]): Promise<RunOutcome> {
    const page = await context.newPage()
    const consoleErrors: string[] = []
    const consoleWarnings: string[] = []
    const pageErrors: string[] = []

    page.on('console', (message) => {
      const type = message.type()
      if (type === 'error') consoleErrors.push(message.text())
      else if (type === 'warning') consoleWarnings.push(message.text())
    })
    page.on('pageerror', (error) => pageErrors.push(String(error.stack ?? error)))

    const caseIndex = this.#caseCounter++
    const snapshots: DomSnapshot[] = []
    let traceStoppedAt: string | undefined

    try {
      await page.goto(`${this.#url}?case=${caseIndex}`, {
        waitUntil: 'load',
        timeout: 30_000,
      })
      const overlay = await this.#waitForMount(page)
      if (overlay) {
        return {
          observation: {
            mounted: false,
            snapshots,
            consoleErrors,
            consoleWarnings,
            pageErrors,
            buildError: overlay,
          },
          actions: replay ?? [],
        }
      }
      await this.#settle(page)

      snapshots.push(await this.#snapshot(page, 'initial'))

      const trace = replay ?? (await this.#recordActions(page))

      for (const [index, action] of trace.entries()) {
        const applied = await this.#apply(page, action)
        if (!applied) {
          traceStoppedAt = `action ${index} (${action.kind} ${action.selector})`
          break
        }
        await this.#settle(page)
        snapshots.push(await this.#snapshot(page, `${index}:${action.kind}`))
      }

      const bus = await page.evaluate(() => {
        const g = globalThis as unknown as {
          __VAPOR_FUZZ__?: { errors: string[]; warnings: string[]; mounted: boolean }
        }
        return {
          errors: g.__VAPOR_FUZZ__?.errors ?? [],
          warnings: g.__VAPOR_FUZZ__?.warnings ?? [],
          mounted: g.__VAPOR_FUZZ__?.mounted === true,
        }
      })

      return {
        observation: {
          mounted: bus.mounted,
          snapshots,
          consoleErrors: [...consoleErrors, ...bus.errors],
          consoleWarnings: [...consoleWarnings, ...bus.warnings],
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
      await page.close().catch(() => {})
    }
  }

  /**
   * Wait for the app to mount, or report Vite's error overlay.
   *
   * A transform failure never reaches `app.mount()`, so waiting for the mount
   * flag would just burn the whole timeout and report "timed out" for what is
   * really a one-line compile error. Vite puts that error in the page as a
   * `<vite-error-overlay>`, so watch for either outcome.
   */
  async #waitForMount(page: Page): Promise<string | undefined> {
    try {
      const result = await page.waitForFunction(
        () => {
          const g = globalThis as unknown as {
            __VAPOR_FUZZ__?: { mounted: boolean; failed: boolean }
          }
          if (g.__VAPOR_FUZZ__?.mounted === true || g.__VAPOR_FUZZ__?.failed === true) {
            return { kind: 'mounted' as const }
          }
          const overlay = document.querySelector('vite-error-overlay')
          if (overlay) {
            return {
              kind: 'overlay' as const,
              text: (overlay.shadowRoot ?? overlay).textContent ?? '',
            }
          }
          return false
        },
        undefined,
        { timeout: MOUNT_TIMEOUT_MS },
      )
      const value = await result.jsonValue()
      return value && value.kind === 'overlay' ? value.text.trim().slice(0, 2000) : undefined
    } catch (error) {
      const overlay = await page
        .locator('vite-error-overlay')
        .first()
        .textContent()
        .catch(() => null)
      if (overlay) return overlay.trim().slice(0, 2000)
      throw error
    }
  }

  /**
   * Wait until the DOM stops moving.
   *
   * A fixed pause is the wrong tool: too short and a ripple is caught halfway
   * between `--in` and `--out`, too long and every snapshot in a campaign of
   * hundreds pays for the slowest component in the corpus. Polling for
   * quiescence adapts -- a static tree settles in one tick, a component library
   * with JS-driven teardown timers gets the time it actually needs.
   */
  async #settle(page: Page): Promise<void> {
    await page.evaluate(
      ([minPauseMs, maxWaitMs]) =>
        new Promise<void>((resolve) => {
          const deadline = performance.now() + (maxWaitMs as number)
          const root = document.querySelector('#app')
          let previous = ''
          let stableTicks = 0

          const tick = (): void => {
            const current = root?.innerHTML ?? ''
            stableTicks = current === previous ? stableTicks + 1 : 0
            previous = current
            if (stableTicks >= 2 || performance.now() > deadline) {
              setTimeout(resolve, minPauseMs as number)
              return
            }
            setTimeout(() => requestAnimationFrame(tick), 25)
          }

          requestAnimationFrame(() => requestAnimationFrame(tick))
        }),
      [this.#options.settleMs, SETTLE_MAX_MS] as const,
    )
  }

  async #snapshot(page: Page, label: string): Promise<DomSnapshot> {
    const captured: CapturedDom = await page.evaluate(captureDom, '#app')
    return { label, html: captured.html, text: captured.text }
  }

  async #recordActions(page: Page): Promise<PageAction[]> {
    // Both helpers are passed by reference: Playwright serialises the function
    // itself, so wrapping them in an arrow would leave the browser looking for
    // a module-scoped binding that does not exist there.
    return page.evaluate(collectActions, {
      rootSelector: '#app',
      limit: this.#options.maxActions,
    })
  }

  async #apply(page: Page, action: PageAction): Promise<boolean> {
    const locator = page.locator(action.selector).first()
    if ((await locator.count()) === 0) return false
    try {
      switch (action.kind) {
        case 'click':
          await locator.click({ timeout: 4000, force: true })
          return true
        case 'hover':
          await locator.hover({ timeout: 4000, force: true })
          return true
        case 'type':
          await locator.fill(action.value ?? '', { timeout: 4000 })
          return true
        case 'key':
          await locator.press(action.value ?? 'Enter', { timeout: 4000 })
          return true
      }
    } catch {
      return false
    }
  }
}

export interface RunOutcome {
  readonly observation: CaseObservation
  readonly actions: readonly PageAction[]
}

async function loadExtraPlugins(
  plan: SpecimenTargetPlan,
  isVapor: (absoluteId: string) => boolean,
): Promise<Plugin[]> {
  if (!plan.config.vitePluginsModule) return []
  const mod = (await import(fromId(plan.config.vitePluginsModule))) as {
    default?: (isVapor: (absoluteId: string) => boolean) => Plugin[]
  }
  return mod.default?.(isVapor) ?? []
}
