import { describe, expect, it } from 'vite-plus/test'
import { detectVolatileAttributes, maskAttributes } from '../src/volatile.ts'

const withActivated = (value: string) =>
  ['<div class="a">', `  <span data-activated="${value}" class="ripple">`, '    #text x'].join('\n')

describe('detectVolatileAttributes', () => {
  it('finds an attribute that moved between two identical renders', () => {
    expect(detectVolatileAttributes(withActivated('340.3'), withActivated('313.4'))).toEqual([
      'data-activated',
    ])
  })

  it('finds nothing when the renders agree', () => {
    expect(detectVolatileAttributes(withActivated('1'), withActivated('1'))).toEqual([])
  })

  it('refuses to mask when the trees differ in shape', () => {
    expect(detectVolatileAttributes('<a>\n<b>\n', '<a>\n')).toEqual([])
  })

  it('refuses to mask when an element gained an attribute', () => {
    expect(detectVolatileAttributes('<a x="1">\n', '<a x="1" y="2">\n')).toEqual([])
  })

  it('refuses to mask when text content also differs', () => {
    const a = '<a x="1">\n  #text one\n'
    const b = '<a x="2">\n  #text two\n'
    expect(detectVolatileAttributes(a, b)).toEqual([])
  })

  it('never quarantines an attribute the comparison depends on', () => {
    // A `class` that moves between two identical renders is a transition caught
    // mid-flight. Masking it would make the specimen look stable by making it
    // blind, so the specimen has to be discarded instead.
    for (const name of ['class', 'style', 'id', ':value', ':checked']) {
      expect(detectVolatileAttributes(`<a ${name}="one">\n`, `<a ${name}="two">\n`), name).toEqual(
        [],
      )
    }
  })

  it('parses hyphenated and namespaced attribute names', () => {
    expect(
      detectVolatileAttributes(
        '<li aria-activedescendant="opt-3">\n',
        '<li aria-activedescendant="opt-8">\n',
      ),
    ).toEqual(['aria-activedescendant'])
  })
})

describe('maskAttributes', () => {
  it('masks only the named attributes', () => {
    const masked = maskAttributes('<a data-activated="9.1" id="keep">', ['data-activated'])
    expect(masked).toBe('<a data-activated="<volatile>" id="keep">')
  })

  it('is a no-op with an empty list', () => {
    expect(maskAttributes('<a x="1">', [])).toBe('<a x="1">')
  })

  it('makes two volatile renders compare equal', () => {
    const names = detectVolatileAttributes(withActivated('340.3'), withActivated('313.4'))
    expect(maskAttributes(withActivated('340.3'), names)).toBe(
      maskAttributes(withActivated('313.4'), names),
    )
  })
})
