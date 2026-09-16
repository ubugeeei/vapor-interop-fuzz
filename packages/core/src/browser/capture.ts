/**
 * Page-side helpers.
 *
 * Everything in this file is injected into the browser by Playwright via
 * `page.evaluate`, which serialises the function source. That means each
 * exported function must be completely self-contained: no imports, no outer
 * scope, no shared helpers at module level.
 */

export interface CapturedDom {
  html: string
  text: string
}

/**
 * Serialise the mounted tree into a form that is comparable across runtimes.
 *
 * Vapor and the virtual DOM legitimately differ in bookkeeping that is not
 * observable to a user: anchor comments, whitespace-only text nodes, attribute
 * order, class token order. Those are normalised away. Anything a user could
 * actually see or interact with is kept -- including live form control state,
 * which never shows up in `outerHTML` and is precisely where `v-model` interop
 * bugs hide.
 */
export function captureDom(rootSelector: string): CapturedDom {
  const root = document.querySelector(rootSelector)
  if (!root) return { html: '<!-- mount root missing -->', text: '' }

  const SKIP_ATTRS = new Set(['data-vapor-fuzz-ignore'])

  // Every helper below is nested on purpose: Playwright serialises this
  // function's source and evaluates it in a page that has no module scope, so a
  // helper hoisted to the outer scope would simply be undefined there.
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  function normalizeWhitespace(value: string): string {
    return value.replace(/\s+/g, ' ').trim()
  }

  function serializeAttrs(el: Element): string {
    const parts: string[] = []
    for (const attr of Array.from(el.attributes)) {
      if (SKIP_ATTRS.has(attr.name)) continue
      let value = attr.value
      if (attr.name === 'class') {
        // Vapor and the VDOM merge static + dynamic classes in different
        // orders. The rendered result is identical, so compare as a set.
        value = value.split(/\s+/).filter(Boolean).toSorted().join(' ')
        if (value === '') continue
      } else if (attr.name === 'style') {
        value = value
          .split(';')
          .map((s) => normalizeWhitespace(s))
          .filter(Boolean)
          .toSorted()
          .join('; ')
        if (value === '') continue
      } else {
        value = normalizeWhitespace(value)
      }
      parts.push(`${attr.name}="${value.replace(/"/g, '&quot;')}"`)
    }

    // Live control state: `outerHTML` shows the *attribute*, not the property,
    // so a v-model that silently stops updating would otherwise look identical.
    if (el instanceof HTMLInputElement) {
      parts.push(`:value="${el.value}"`, `:checked="${el.checked}"`)
    } else if (el instanceof HTMLTextAreaElement) {
      parts.push(`:value="${el.value}"`)
    } else if (el instanceof HTMLSelectElement) {
      parts.push(`:value="${el.value}"`)
    }
    if (el === document.activeElement) parts.push(':focused="true"')

    return parts.toSorted().join(' ')
  }

  function serialize(node: Node, depth: number): string {
    if (node.nodeType === Node.COMMENT_NODE) return ''
    if (node.nodeType === Node.TEXT_NODE) {
      const text = normalizeWhitespace(node.nodeValue ?? '')
      return text === '' ? '' : `${'  '.repeat(depth)}#text ${text}\n`
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return ''

    const el = node as Element
    const tag = el.tagName.toLowerCase()
    const attrs = serializeAttrs(el)
    const indent = '  '.repeat(depth)
    let out = `${indent}<${tag}${attrs ? ` ${attrs}` : ''}>\n`
    for (const child of Array.from(el.childNodes)) out += serialize(child, depth + 1)
    return out
  }

  let html = ''
  for (const child of Array.from(root.childNodes)) html += serialize(child, 0)

  return { html, text: normalizeWhitespace(root.textContent ?? '') }
}

export interface PageAction {
  kind: 'click' | 'type' | 'key' | 'hover'
  selector: string
  value?: string
}

/**
 * Derive a deterministic interaction script from the *baseline* DOM.
 *
 * The same script is then replayed verbatim against every mutant. Recomputing
 * it per run would be a trap: the first DOM divergence would change what the
 * mutant clicks, and every later snapshot would differ for the wrong reason.
 */
export function collectActions(options: { rootSelector: string; limit: number }): PageAction[] {
  const { rootSelector, limit } = options
  const root = document.querySelector(rootSelector)
  if (!root) return []

  function selectorFor(el: Element): string {
    const parts: string[] = []
    let current: Element | null = el
    while (current && current !== root) {
      const parent: Element | null = current.parentElement
      if (!parent) break
      const index = Array.prototype.indexOf.call(parent.children, current) + 1
      parts.unshift(`${current.tagName.toLowerCase()}:nth-child(${index})`)
      current = parent
    }
    return [rootSelector, ...parts].join(' > ')
  }

  const interactive = Array.from(
    root.querySelectorAll(
      'button, a[href], input, select, textarea, summary, [role="button"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="switch"], [role="option"], [tabindex]:not([tabindex="-1"])',
    ),
  )

  const actions: PageAction[] = []
  for (const el of interactive) {
    if (actions.length >= limit) break
    const selector = selectorFor(el)
    if (el instanceof HTMLInputElement) {
      const type = el.type.toLowerCase()
      if (type === 'checkbox' || type === 'radio') actions.push({ kind: 'click', selector })
      else if (type === 'text' || type === 'search' || type === 'email' || type === 'number')
        actions.push({ kind: 'type', selector, value: 'fz1' })
      else actions.push({ kind: 'click', selector })
    } else if (el instanceof HTMLTextAreaElement) {
      actions.push({ kind: 'type', selector, value: 'fz1' })
    } else if (el instanceof HTMLSelectElement) {
      actions.push({ kind: 'key', selector, value: 'ArrowDown' })
    } else {
      actions.push({ kind: 'click', selector })
    }
  }
  return actions
}
