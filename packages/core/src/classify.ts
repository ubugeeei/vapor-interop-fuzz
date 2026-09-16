/**
 * Known divergences.
 *
 * Some Vapor/VDOM differences are real, understood, and pervasive -- the kind
 * that would otherwise be rediscovered on every specimen in every target and
 * bury anything new. Each one is described here together with the check that
 * decides whether it *fully* explains what we observed. A difference that is
 * only partly explained stays unclassified, because the leftover is the
 * interesting part.
 */
export interface KnownDivergence {
  readonly id: string
  readonly title: string
  readonly explanation: string
  /** True when removing this effect makes the two trees identical. */
  readonly explainsDom?: (expected: string, actual: string) => boolean
  /** True when this error is a known consequence of the divergence. */
  readonly explainsError?: (text: string) => boolean
}

const SLOTTED_SCOPE_ID = / data-v-[0-9a-f]+-s=""/g

export const KNOWN_DIVERGENCES: readonly KnownDivergence[] = [
  {
    id: 'vapor-slotted-scope-id',
    title: 'Vapor emits `data-v-<id>-s` on slot content unconditionally',
    explanation:
      'A component with `<style scoped>` that does not use `:slotted()` gets no ' +
      'slotted scope id from the virtual DOM renderer, but does get one from ' +
      'Vapor. The rendered result is visually identical; the DOM is not.',
    explainsDom: (expected, actual) =>
      expected.replace(SLOTTED_SCOPE_ID, '') === actual.replace(SLOTTED_SCOPE_ID, ''),
  },
  {
    id: 'vapor-object-directive-unsupported',
    title: 'Vapor supports only function-form custom directives',
    explanation:
      '`applyDirectivesToElement` in @vue/runtime-vapor calls `dir(element, …)` ' +
      'directly, so an object directive (`{ mounted, updated }`) throws ' +
      '"dir is not a function" as soon as the component is compiled in Vapor ' +
      'Mode. The same component renders fine through the virtual DOM, which ' +
      'makes this a migration hazard rather than a crash anybody expects.',
    explainsError: (text) =>
      /dir is not a function/.test(text) &&
      /applyDirectivesToElement|withVaporDirectives/.test(text),
  },
]

export function classifyDom(expected: string, actual: string): KnownDivergence | undefined {
  return KNOWN_DIVERGENCES.find((d) => d.explainsDom?.(expected, actual))
}

export function classifyError(text: string): KnownDivergence | undefined {
  return KNOWN_DIVERGENCES.find((d) => d.explainsError?.(text))
}

/**
 * Attribute a whole comparison to one known divergence.
 *
 * When every new error has the same known cause, the DOM differences that come
 * with it are downstream of that crash -- reporting them as separate unexplained
 * findings would be noise.
 */
export function classifyErrors(errors: readonly string[]): KnownDivergence | undefined {
  if (errors.length === 0) return undefined
  const first = classifyError(errors[0] as string)
  if (!first) return undefined
  return errors.every((e) => classifyError(e)?.id === first.id) ? first : undefined
}
