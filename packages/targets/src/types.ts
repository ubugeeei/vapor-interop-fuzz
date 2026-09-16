/**
 * Licensing metadata is a first-class part of a target definition, not a
 * comment. The fuzzer *modifies* the code it is pointed at, so "may we modify
 * and is this vendored lawfully" has to be answerable mechanically --
 * `vp run targets:licenses` prints this table and fails on anything unresolved.
 */
export interface TargetLicense {
  /** SPDX id, or the license's own name when it is not an SPDX license. */
  readonly id: string
  readonly osiApproved: boolean
  /** Whether the license grants the right to modify / create derivative works. */
  readonly modificationGranted: boolean
  /** Path to the license text inside the submodule. */
  readonly file: string
  readonly notes?: string
}

export interface SpecimenConfig {
  /** Globs (relative to the target dir) of files that can be mounted directly. */
  readonly specimens: readonly string[]
  readonly specimenExclude?: readonly string[]
  /**
   * Globs (relative to the target dir) of files the mutator may flip between
   * Vapor and the virtual DOM. Usually a superset of `specimens`.
   */
  readonly mutable: readonly string[]
  readonly mutableExclude?: readonly string[]
  /** Drop specimens whose own root component cannot compile in Vapor Mode. */
  readonly requireEligibleRoot?: boolean
  /**
   * Whether every component a specimen renders is within reach of the mutator.
   *
   * True when the target's own library source is aliased in (Reka UI), false
   * when specimens render components from a prebuilt npm package (Vuetify).
   * Only a fully-mutable tree can be fuzzed in the `pure-vapor` shape, which
   * runs with no interop bridge at all.
   */
  readonly treeFullyMutable?: boolean
  /** Module id -> path relative to the workspace root. */
  readonly alias?: Readonly<Record<string, string>>
  /**
   * Internal path aliases to rewrite to relative specifiers *in the source*,
   * before `@vue/compiler-sfc` sees it.
   *
   * A Vite `resolve.alias` is enough for the bundler, but not for the SFC
   * compiler: `defineProps<T>()` where `T` extends an imported type is resolved
   * by compiler-sfc itself, which reads the nearest `tsconfig.json` rather than
   * the Vite config. Repositories that keep their real `paths` in a *referenced*
   * tsconfig (reka-ui does) therefore fail with "Failed to resolve extends base
   * type" even though the bundle would have linked fine. Rewriting the
   * specifier makes both resolvers agree.
   *
   * Prefix -> directory relative to the workspace root.
   */
  readonly rewriteAlias?: Readonly<Record<string, string>>
  /** Stylesheets the harness imports before mounting. */
  readonly css?: readonly string[]
  /**
   * Module that customises the generated app, relative to the workspace root.
   * It must default-export `{ install?(app): void }`.
   */
  readonly setupModule?: string
  /**
   * Extra Vite plugins, as a module path relative to the workspace root.
   *
   * It must default-export
   * `(isVapor: (absoluteId: string) => boolean) => Plugin[]`. The predicate is
   * *live*: it reads the plan for the case currently being rendered, so a
   * plugin can route a file to one compiler or another without the server
   * being restarted. That is how the component-level switch works for a
   * JSX-authored target, which has no `vapor` block attribute to toggle.
   */
  readonly vitePluginsModule?: string
}

export interface AppConfig {
  /** Command that boots the target's own dev server. */
  readonly dev: readonly string[]
  /** Working directory, relative to the target dir. */
  readonly cwd?: string
  /** Where the dev server listens. */
  readonly port: number
  /** Routes to drive. */
  readonly routes: readonly string[]
  /** Globs (relative to the target dir) the mutator may flip. */
  readonly mutable: readonly string[]
  readonly mutableExclude?: readonly string[]
  /**
   * Nuxt and friends own `createApp`, so the app-level switch degrades to
   * "VDOM root + interop bridge". Recorded so the report does not imply
   * coverage the run never had.
   */
  readonly appLevelSwitchable: boolean
  readonly notes?: string
}

export type TargetRequirement = 'install' | 'backend' | 'submodule'

export interface TargetDefinition {
  readonly id: string
  readonly title: string
  /** `owner/name` on GitHub, or `null` for the in-repo fixture. */
  readonly repo: string | null
  readonly branch?: string
  /** Path relative to the workspace root. */
  readonly dir: string
  readonly license: TargetLicense
  readonly requires: readonly TargetRequirement[]
  /** Included when `vp run fuzz` is invoked without `--target`. */
  readonly enabledByDefault: boolean
  readonly mode: 'specimen' | 'app'
  readonly specimen?: SpecimenConfig
  readonly app?: AppConfig
  readonly notes?: string
}
