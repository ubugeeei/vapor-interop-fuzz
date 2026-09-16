import path from 'node:path'
import { describe, expect, it } from 'vite-plus/test'
import { renderEntry, rewriteAliasImports } from '../src/vite-plugin.ts'

const SRC = '/w/targets/lib/src'
const FILE = `${SRC}/Combobox/Item.vue`
const rewrites = [{ prefix: '@/', dir: SRC }]

describe('rewriteAliasImports', () => {
  it('rewrites an internal alias to a relative specifier', () => {
    const out = rewriteAliasImports(`import { P } from '@/Primitive'\n`, FILE, rewrites)
    expect(out).toBe(`import { P } from '../Primitive'\n`)
  })

  it('handles both quote styles and nested paths', () => {
    const out = rewriteAliasImports(`import a from "@/shared/color/index.ts"\n`, FILE, rewrites)
    expect(out).toBe(`import a from "../shared/color/index.ts"\n`)
  })

  it('leaves package specifiers alone', () => {
    const code = `import { x } from '@vueuse/core'\nimport y from 'vue'\n`
    expect(rewriteAliasImports(code, FILE, rewrites)).toBe(code)
  })

  it('always emits an explicit relative prefix', () => {
    const sibling = `${SRC}/Combobox/Root.vue`
    const out = rewriteAliasImports(`import a from '@/Combobox/Other.vue'\n`, sibling, rewrites)
    expect(out).toContain(`'./Other.vue'`)
  })

  it('does nothing for file types the SFC compiler never reads', () => {
    const code = `@import '@/styles.css';`
    expect(rewriteAliasImports(code, '/w/x.css', rewrites)).toBe(code)
  })

  it('is a no-op without rewrites configured', () => {
    const code = `import { P } from '@/Primitive'\n`
    expect(rewriteAliasImports(code, FILE, [])).toBe(code)
  })
})

describe('renderEntry', () => {
  const specimenPath = path.posix.join('/w', 'spec.vue')

  it('mounts a virtual-DOM app with the bridge installed', () => {
    const code = renderEntry({ specimenPath, vaporRoot: false, interop: true })
    expect(code).toContain('createApp')
    expect(code).not.toContain('createVaporApp')
    expect(code).toContain('app.use(vaporInteropPlugin)')
  })

  it('mounts a Vapor app with the bridge installed', () => {
    const code = renderEntry({ specimenPath, vaporRoot: true, interop: true })
    expect(code).toContain('createVaporApp')
    expect(code).toContain('app.use(vaporInteropPlugin)')
  })

  it('omits the bridge entirely for the unbridged control modes', () => {
    const code = renderEntry({ specimenPath, vaporRoot: false, interop: false })
    expect(code).not.toContain('vaporInteropPlugin')
  })

  it('captures errors through Vue hooks rather than the console', () => {
    const code = renderEntry({ specimenPath, vaporRoot: false, interop: true })
    expect(code).toContain('app.config.errorHandler')
    expect(code).toContain('app.config.warnHandler')
    expect(code).toContain('bus.mounted = true')
  })

  it('wires the optional setup module and stylesheets', () => {
    const code = renderEntry({
      specimenPath,
      vaporRoot: false,
      interop: true,
      setupPath: '/w/setup.ts',
      cssPaths: ['/w/a.css'],
    })
    expect(code).toContain('setup?.install?.(app)')
    expect(code).toContain('"/w/a.css"')
  })
})
