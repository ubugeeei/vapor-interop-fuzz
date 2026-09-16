import { parse } from '@vue/compiler-sfc'

/**
 * Component-level Vapor switching.
 *
 * Vue 3.6 opts an SFC into Vapor Mode with a bare `vapor` attribute on a
 * top-level block (`<script setup vapor>`, or `<template vapor>` for
 * template-only files). Flipping a component is therefore a pure source
 * rewrite, which is exactly what we want: the fuzzer can do it in a Vite
 * `transform` hook and never has to dirty a submodule's working tree.
 */

export interface SfcAnalysis {
  readonly hasScriptSetup: boolean
  readonly hasPlainScript: boolean
  readonly hasTemplate: boolean
  readonly hasExternalBlock: boolean
  /** The file already carries `vapor` in its own source. */
  readonly authoredVapor: boolean
  readonly eligible: boolean
  readonly reason?: string
  readonly parseErrors: readonly string[]
}

const NOT_VUE = 'not a .vue single-file component'

/**
 * Mirrors `canForceVaporMode` in @vitejs/plugin-vue: Vapor SFC support requires
 * `<script setup>`, or no `<script>` at all. An SFC whose only script block is a
 * plain Options API `<script>` can never compile in Vapor Mode, so flipping it
 * would just manufacture a compile error rather than test interop.
 */
export function analyzeSfc(source: string, filename: string): SfcAnalysis {
  if (!filename.endsWith('.vue')) {
    return {
      hasScriptSetup: false,
      hasPlainScript: false,
      hasTemplate: false,
      hasExternalBlock: false,
      authoredVapor: false,
      eligible: false,
      reason: NOT_VUE,
      parseErrors: [],
    }
  }

  const { descriptor, errors } = parse(source, { filename })
  const parseErrors = errors.map((e) => e.message)

  const hasScriptSetup = descriptor.scriptSetup != null
  const hasPlainScript = descriptor.script != null
  const hasTemplate = descriptor.template != null
  const hasExternalBlock =
    descriptor.template?.src != null ||
    descriptor.script?.src != null ||
    descriptor.scriptSetup?.src != null

  const base = {
    hasScriptSetup,
    hasPlainScript,
    hasTemplate,
    hasExternalBlock,
    authoredVapor: descriptor.vapor === true,
    parseErrors,
  }

  if (parseErrors.length > 0) {
    return { ...base, eligible: false, reason: `parse error: ${parseErrors[0]}` }
  }
  if (hasExternalBlock) {
    return { ...base, eligible: false, reason: 'uses a `src` block' }
  }
  if (!hasTemplate) {
    return { ...base, eligible: false, reason: 'no <template> block' }
  }
  if (!hasScriptSetup && hasPlainScript) {
    return { ...base, eligible: false, reason: 'Options API <script> without <script setup>' }
  }

  return { ...base, eligible: true }
}

export interface RewriteResult {
  readonly code: string
  readonly changed: boolean
}

/**
 * Add or remove the `vapor` attribute.
 *
 * The attribute goes on `<script setup>` when there is one, otherwise on
 * `<template>` -- the same two places the SFC parser looks.
 */
export function setVapor(source: string, filename: string, vapor: boolean): RewriteResult {
  const { descriptor } = parse(source, { filename })

  const blocks: Array<{ tag: string; contentStart: number }> = []
  if (descriptor.scriptSetup) {
    blocks.push({ tag: 'script', contentStart: descriptor.scriptSetup.loc.start.offset })
  }
  if (descriptor.script) {
    blocks.push({ tag: 'script', contentStart: descriptor.script.loc.start.offset })
  }
  if (descriptor.template) {
    blocks.push({ tag: 'template', contentStart: descriptor.template.loc.start.offset })
  }

  if (vapor) {
    // Adding: one block is enough, and `<script setup>` is the idiomatic spot.
    const target = descriptor.scriptSetup
      ? { tag: 'script', contentStart: descriptor.scriptSetup.loc.start.offset }
      : descriptor.template
        ? { tag: 'template', contentStart: descriptor.template.loc.start.offset }
        : undefined
    if (!target) return { code: source, changed: false }

    const span = findOpenTag(source, target.tag, target.contentStart)
    if (!span) return { code: source, changed: false }
    if (hasVaporAttr(span.text)) return { code: source, changed: false }

    const patched = `${span.text.slice(0, -1).trimEnd()} vapor>`
    return { code: splice(source, span.start, span.end, patched), changed: true }
  }

  // Removing: strip it from every block, since an author may have put it on
  // `<template>` even though a `<script setup>` exists.
  let code = source
  let changed = false
  // Right-to-left so earlier offsets stay valid.
  for (const block of blocks.toSorted((a, b) => b.contentStart - a.contentStart)) {
    const span = findOpenTag(code, block.tag, block.contentStart)
    if (!span || !hasVaporAttr(span.text)) continue
    code = splice(code, span.start, span.end, stripVaporAttr(span.text))
    changed = true
  }
  return { code, changed }
}

interface TagSpan {
  readonly start: number
  readonly end: number
  readonly text: string
}

/**
 * Recover the opening tag for a block whose *content* starts at `contentStart`.
 *
 * The SFC parser only hands back content locations, and scanning backwards for
 * a bare `<` is not safe -- `generic="T extends Array<X>"` is real code in the
 * wild. Searching backwards for the literal tag name is.
 */
function findOpenTag(source: string, tag: string, contentStart: number): TagSpan | undefined {
  const start = source.lastIndexOf(`<${tag}`, contentStart)
  if (start < 0 || start >= contentStart) return undefined
  const end = contentStart
  if (source[end - 1] !== '>') return undefined
  return { start, end, text: source.slice(start, end) }
}

const VAPOR_ATTR = /(^|\s)vapor(?=[\s/>=])/

function hasVaporAttr(openTag: string): boolean {
  return VAPOR_ATTR.test(openTag)
}

function stripVaporAttr(openTag: string): string {
  return openTag.replace(/\svapor(?=[\s/>])/, '')
}

function splice(source: string, start: number, end: number, replacement: string): string {
  return source.slice(0, start) + replacement + source.slice(end)
}
