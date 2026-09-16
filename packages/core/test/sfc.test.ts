import { describe, expect, it } from 'vite-plus/test'
import { analyzeSfc, setVapor } from '../src/sfc.ts'

const file = '/x/Comp.vue'

describe('analyzeSfc', () => {
  it('accepts a <script setup> SFC', () => {
    const analysis = analyzeSfc(
      `<script setup lang="ts">const a = 1</script>\n<template><p>{{ a }}</p></template>`,
      file,
    )
    expect(analysis.eligible).toBe(true)
    expect(analysis.hasScriptSetup).toBe(true)
    expect(analysis.authoredVapor).toBe(false)
  })

  it('accepts a template-only SFC', () => {
    expect(analyzeSfc('<template><p>hi</p></template>', file).eligible).toBe(true)
  })

  it("rejects an Options API SFC, matching plugin-vue's canForceVaporMode", () => {
    const analysis = analyzeSfc(
      `<script>export default { data: () => ({ a: 1 }) }</script>\n<template><p>{{ a }}</p></template>`,
      file,
    )
    expect(analysis.eligible).toBe(false)
    expect(analysis.reason).toContain('Options API')
  })

  it('still accepts <script setup> alongside an Options API <script>', () => {
    const analysis = analyzeSfc(
      `<script>export default { name: 'C' }</script>\n<script setup>const a = 1</script>\n<template><p>{{ a }}</p></template>`,
      file,
    )
    expect(analysis.eligible).toBe(true)
  })

  it('rejects a src block and a template-less SFC', () => {
    expect(analyzeSfc('<template src="./t.html"></template>', file).eligible).toBe(false)
    expect(analyzeSfc('<script setup>const a = 1</script>', file).eligible).toBe(false)
  })

  it('detects an authored vapor marker on either block', () => {
    expect(
      analyzeSfc('<script setup vapor>const a = 1</script>\n<template><p/></template>', file)
        .authoredVapor,
    ).toBe(true)
    expect(analyzeSfc('<template vapor><p/></template>', file).authoredVapor).toBe(true)
  })
})

describe('setVapor', () => {
  it('adds the marker to <script setup>', () => {
    const source = `<script setup lang="ts">const a = 1</script>\n<template><p/></template>`
    const { code, changed } = setVapor(source, file, true)
    expect(changed).toBe(true)
    expect(code).toContain('<script setup lang="ts" vapor>')
    expect(analyzeSfc(code, file).authoredVapor).toBe(true)
  })

  it('adds the marker to <template> when there is no script setup', () => {
    const { code } = setVapor('<template><p/></template>', file, true)
    expect(code.startsWith('<template vapor>')).toBe(true)
  })

  it('is idempotent in both directions', () => {
    const source = `<script setup>const a = 1</script>\n<template><p/></template>`
    const on = setVapor(source, file, true).code
    expect(setVapor(on, file, true).changed).toBe(false)
    const off = setVapor(on, file, false).code
    expect(off).toBe(source)
    expect(setVapor(off, file, false).changed).toBe(false)
  })

  it('strips a marker authored on <template> even when a script setup exists', () => {
    const source = `<script setup>const a = 1</script>\n<template vapor><p/></template>`
    const { code } = setVapor(source, file, false)
    expect(analyzeSfc(code, file).authoredVapor).toBe(false)
  })

  it('survives a generic attribute containing angle brackets', () => {
    // `generic="T extends Array<X>"` puts a `<` inside the open tag, which is
    // why the rewriter looks for the tag name rather than scanning back to the
    // nearest `<`.
    const source =
      `<script setup lang="ts" generic="T extends Array<number>">defineProps<{ i: T }>()</script>\n` +
      `<template><p/></template>`
    const { code } = setVapor(source, file, true)
    expect(code).toContain('generic="T extends Array<number>" vapor>')
    expect(analyzeSfc(code, file).authoredVapor).toBe(true)
  })

  it('does not mistake a data-vapor attribute for the marker', () => {
    const source = `<script setup data-vapor="no">const a = 1</script>\n<template><p/></template>`
    expect(analyzeSfc(source, file).authoredVapor).toBe(false)
    expect(setVapor(source, file, true).code).toContain('data-vapor="no" vapor>')
  })
})
