import { fileURLToPath } from 'node:url'
import path from 'node:path'

/** Workspace root, resolved from this file rather than from `process.cwd()`. */
export const WORKSPACE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

export const FUZZ_DIR = path.join(WORKSPACE_ROOT, '.fuzz')
export const REPORT_DIR = path.join(WORKSPACE_ROOT, 'reports')

/** Workspace-relative, POSIX-separated. This is the canonical id for a file. */
export function toId(absPath: string): string {
  return path.relative(WORKSPACE_ROOT, absPath).replaceAll(path.sep, '/')
}

export function fromId(id: string): string {
  return path.resolve(WORKSPACE_ROOT, id)
}

/** Strip Vite's query suffix and normalise separators. */
export function cleanModuleId(id: string): string {
  const withoutQuery = id.split('?')[0] ?? id
  return withoutQuery.replaceAll('\\', '/')
}
