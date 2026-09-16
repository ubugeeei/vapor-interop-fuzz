/**
 * Volatile attributes.
 *
 * Real components write values into the DOM that cannot repeat: a timestamp, a
 * measured pixel offset, a random id. Vuetify's ripple, for instance, records
 * `data-activated="340.30000001192093"` -- a `performance.now()` reading. Two
 * *identical* renders disagree on those, which would get every such specimen
 * discarded as nondeterministic and quietly remove a whole component library
 * from the fuzzer's reach.
 *
 * Rather than maintaining a hand-written per-target ignore list, the runner
 * renders the baseline twice and asks this module which attributes moved. If
 * masking exactly those makes the two renders identical, they are quarantined
 * for the rest of the specimen's run -- and named in the report, so a masked
 * attribute is a disclosed limitation rather than a silent one.
 */

const ATTR = /([:\w-]+)="([^"]*)"/g

/**
 * Attributes that are never quarantined, however unstable they look.
 *
 * These carry what the fuzzer exists to compare. A `class` that disagrees
 * between two identical renders is a transition caught mid-flight, not a
 * timestamp -- masking it would make the specimen "stable" by making it blind.
 * Better to discard the specimen and say so.
 */
const NEVER_MASK: ReadonlySet<string> = new Set([
  'class',
  'style',
  'id',
  'href',
  'src',
  'type',
  ':value',
  ':checked',
  ':focused',
])

/**
 * Attribute names whose values differ between two renders that are otherwise
 * structurally identical. Returns an empty list when the trees differ in shape,
 * because then the difference is real and must not be masked away.
 */
export function detectVolatileAttributes(a: string, b: string): string[] {
  const linesA = a.split('\n')
  const linesB = b.split('\n')
  if (linesA.length !== linesB.length) return []

  const names = new Set<string>()
  for (const [index, lineA] of linesA.entries()) {
    const lineB = linesB[index] as string
    if (lineA === lineB) continue

    const attrsA = readAttrs(lineA)
    const attrsB = readAttrs(lineB)
    if (attrsA === undefined || attrsB === undefined) return []
    if (attrsA.size !== attrsB.size) return []

    for (const [name, value] of attrsA) {
      if (!attrsB.has(name)) return []
      if (attrsB.get(name) !== value) names.add(name)
    }

    // Everything outside the attribute values must already agree, otherwise
    // masking would be hiding a genuine difference.
    if (mask(lineA, names) !== mask(lineB, names)) return []
  }
  for (const name of names) {
    if (NEVER_MASK.has(name)) return []
  }
  return [...names].toSorted()
}

/** Replace the value of every named attribute with a placeholder. */
export function maskAttributes(html: string, names: readonly string[]): string {
  return names.length === 0 ? html : mask(html, new Set(names))
}

function mask(text: string, names: ReadonlySet<string>): string {
  if (names.size === 0) return text
  return text.replace(ATTR, (match, name: string) =>
    names.has(name) ? `${name}="<volatile>"` : match,
  )
}

function readAttrs(line: string): Map<string, string> | undefined {
  const out = new Map<string, string>()
  for (const match of line.matchAll(ATTR)) {
    const name = match[1] as string
    if (out.has(name)) return undefined
    out.set(name, match[2] as string)
  }
  return out
}
