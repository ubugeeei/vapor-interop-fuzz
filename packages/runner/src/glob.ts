import { glob } from 'node:fs/promises'
import path from 'node:path'

/**
 * Resolve include/exclude globs against a directory.
 *
 * Uses Node's built-in `fs.glob` so the fuzzer does not need a glob dependency
 * that would then have to be kept in step with the catalog.
 */
export async function globFiles(
  cwd: string,
  include: readonly string[],
  exclude: readonly string[] = [],
): Promise<string[]> {
  const seen = new Set<string>()
  for (const pattern of include) {
    for await (const entry of glob(pattern, { cwd })) {
      seen.add(path.resolve(cwd, entry))
    }
  }
  if (exclude.length > 0) {
    const excluded = new Set<string>()
    for (const pattern of exclude) {
      for await (const entry of glob(pattern, { cwd })) {
        excluded.add(path.resolve(cwd, entry))
      }
    }
    for (const file of excluded) seen.delete(file)
  }
  return [...seen].toSorted()
}
