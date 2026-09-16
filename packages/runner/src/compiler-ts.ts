import * as compilerSfc from '@vue/compiler-sfc'

/**
 * A `@vue/compiler-sfc` instance that can actually resolve types across files.
 *
 * `defineProps<Props>()` where `Props` extends an imported interface is
 * resolved by compiler-sfc itself, and that needs the TypeScript compiler API.
 * Two things get in the way here:
 *
 * 1. `vue/compiler-sfc` auto-runs `registerTS(() => require('typescript'))`,
 *    and in this workspace `typescript` is version 7 -- the native port, whose
 *    npm package exposes neither `sys` nor `createSourceFile` at runtime. The
 *    registered implementation is therefore unusable, and every component in a
 *    library that shares a base props type fails to compile with "Failed to
 *    resolve extends base type".
 * 2. @vitejs/plugin-vue reaches for the compiler with a CommonJS
 *    `require('vue/compiler-sfc')`, which is a *different module instance* from
 *    the ESM `@vue/compiler-sfc` this file imports -- so registering on one has
 *    no effect on the other.
 *
 * Hence: register a classic TypeScript on this instance, and hand this exact
 * instance to the plugin. TypeScript 7 remains the project's type checker
 * (`vp check`); this copy is a library for the SFC compiler and nothing else.
 */
let registered: Promise<void> | undefined

export function vueCompiler(): typeof compilerSfc {
  return compilerSfc
}

export function registerCompilerTypeScript(): Promise<void> {
  registered ??= (async () => {
    const ts = await import('typescript-classic')
    compilerSfc.registerTS(() => ((ts as { default?: unknown }).default ?? ts) as never)
  })()
  return registered
}
