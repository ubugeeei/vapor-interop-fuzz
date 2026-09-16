import { describe, expect, it } from 'vite-plus/test'
import { defaultTargets, getTarget, TARGETS } from '../src/index.ts'

describe('target registry', () => {
  it('has unique ids', () => {
    expect(new Set(TARGETS.map((t) => t.id)).size).toBe(TARGETS.length)
  })

  it('only vendors code we are allowed to modify', () => {
    // The fuzzer rewrites the sources it is pointed at, so a target whose
    // licence does not grant modification has no business being in the list.
    for (const target of TARGETS) {
      expect(target.license.modificationGranted, target.id).toBe(true)
      expect(target.license.file.length, target.id).toBeGreaterThan(0)
    }
  })

  it('keeps non-OSI targets opt-in', () => {
    for (const target of TARGETS) {
      if (!target.license.osiApproved) expect(target.enabledByDefault, target.id).toBe(false)
    }
  })

  it('never enables a target that needs a backend by default', () => {
    for (const target of TARGETS) {
      if (target.requires.includes('backend'))
        expect(target.enabledByDefault, target.id).toBe(false)
      if (target.requires.includes('install'))
        expect(target.enabledByDefault, target.id).toBe(false)
    }
  })

  it('gives every target the config its mode needs', () => {
    for (const target of TARGETS) {
      if (target.mode === 'specimen') {
        expect(target.specimen, target.id).toBeDefined()
        expect(target.specimen?.specimens.length, target.id).toBeGreaterThan(0)
        expect(target.specimen?.mutable.length, target.id).toBeGreaterThan(0)
      } else {
        expect(target.app, target.id).toBeDefined()
        expect(target.app?.routes.length, target.id).toBeGreaterThan(0)
      }
    }
  })

  it('points every submodule target at a path under targets/', () => {
    for (const target of TARGETS) {
      if (target.repo) {
        expect(target.dir.startsWith('targets/'), target.id).toBe(true)
        expect(target.requires, target.id).toContain('submodule')
        expect(target.branch, target.id).toBeTruthy()
      }
    }
  })

  it('orders subpath aliases before the bare specifier they share a prefix with', () => {
    // Vite matches aliases in order and a string `find` also matches `<find>/…`,
    // so `reka-ui` declared first would swallow `reka-ui/date`.
    for (const target of TARGETS) {
      const keys = Object.keys(target.specimen?.alias ?? {})
      keys.forEach((key, index) => {
        for (const later of keys.slice(index + 1)) {
          expect(later.startsWith(`${key}/`), `${target.id}: ${key} before ${later}`).toBe(false)
        }
      })
    }
  })

  it('exposes at least one default target and resolves by id', () => {
    expect(defaultTargets().length).toBeGreaterThan(0)
    expect(getTarget('interop-zoo').id).toBe('interop-zoo')
    expect(() => getTarget('nope')).toThrow(/unknown target/)
  })
})
