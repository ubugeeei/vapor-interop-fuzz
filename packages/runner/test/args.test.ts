import { parseArgs } from 'node:util'
import { describe, expect, it } from 'vite-plus/test'

/**
 * `vp run fuzz -- --seed 1` forwards the `--` to the task. Node's `parseArgs`
 * reads that as "stop parsing options", which would turn every documented flag
 * into a positional and silently ignore it -- the CLI would look like it had
 * accepted a seed and then fuzz with a random one.
 */
function stripSeparator(args: readonly string[]): string[] {
  return args.filter((arg, index, all) => arg !== '--' || all.indexOf('--') !== index)
}

const parse = (args: readonly string[]) =>
  parseArgs({
    args: stripSeparator(args),
    allowPositionals: true,
    options: { seed: { type: 'string' }, target: { type: 'string', multiple: true } },
  })

describe('CLI argument handling', () => {
  it('parses flags forwarded through a Vite Task separator', () => {
    const { values, positionals } = parse(['run', '--', '--seed', '42', '--target', 'reka-ui'])
    expect(values.seed).toBe('42')
    expect(values.target).toEqual(['reka-ui'])
    expect(positionals).toEqual(['run'])
  })

  it('parses the same flags when invoked directly', () => {
    const { values, positionals } = parse(['run', '--seed', '42'])
    expect(values.seed).toBe('42')
    expect(positionals).toEqual(['run'])
  })

  it('keeps a second separator, which is a real argument', () => {
    expect(stripSeparator(['run', '--', '--seed', '1', '--', 'x'])).toEqual([
      'run',
      '--seed',
      '1',
      '--',
      'x',
    ])
  })

  it('leaves argument lists without a separator alone', () => {
    expect(stripSeparator(['list'])).toEqual(['list'])
  })
})
