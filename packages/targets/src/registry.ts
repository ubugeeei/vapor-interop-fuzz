import type { TargetDefinition } from './types.ts'

const MIT = (file: string) => ({
  id: 'MIT',
  osiApproved: true,
  modificationGranted: true,
  file,
})

/**
 * Every target is vendored as a shallow git submodule under `targets/`, and
 * every one of them is listed here with the licence that lets us modify it.
 *
 * Deliberately **not** included: `vuejs-jp/vuefes-2025-website`. It ships no
 * LICENSE file, so there is no grant to modify or redistribute it, however
 * convenient a Nuxt 4 target it would have been.
 */
export const TARGETS: readonly TargetDefinition[] = [
  {
    id: 'interop-zoo',
    title: 'interop-zoo (in-repo fixture)',
    repo: null,
    dir: 'fixtures/interop-zoo',
    license: { ...MIT('LICENSE'), notes: 'Written for this repository.' },
    requires: [],
    enabledByDefault: true,
    mode: 'specimen',
    specimen: {
      specimens: ['src/specimens/*.vue'],
      mutable: ['src/specimens/*.vue', 'src/components/*.vue'],
      requireEligibleRoot: true,
      treeFullyMutable: true,
    },
    notes:
      'Dense, dependency-free and fully Vapor-eligible, so it can exercise the ' +
      '`pure-vapor` shape that needs every component in the tree to convert.',
  },

  {
    id: 'reka-ui',
    title: 'Reka UI',
    repo: 'unovue/reka-ui',
    branch: 'v2',
    dir: 'targets/reka-ui',
    license: MIT('LICENSE'),
    requires: ['submodule'],
    enabledByDefault: true,
    mode: 'specimen',
    specimen: {
      // The docs demos are the good specimens: self-contained, prop-free and
      // backend-free. The Histoire `*.story.vue` files are not -- they need
      // `<Story>`/`<Variant>` globals that only exist inside Histoire.
      specimens: ['docs/components/demo/**/index.vue'],
      mutable: ['docs/components/demo/**/*.vue', 'packages/core/src/**/*.vue'],
      mutableExclude: ['packages/core/src/**/story/**', 'packages/core/src/**/*.story.vue'],
      requireEligibleRoot: true,
      treeFullyMutable: true,
      // Point the bare `reka-ui` specifier at the library *source* so the
      // library's own SFCs become mutable, instead of at a prebuilt bundle.
      //
      // Order matters: Vite matches aliases in declaration order and a string
      // `find` also matches the `<find>/…` prefix, so the subpath entries have
      // to come before the bare one. `@` is the library's own internal alias,
      // declared in `packages/core/vite.config.ts`.
      alias: {
        'reka-ui/date': 'targets/reka-ui/packages/core/src/date/index.ts',
        'reka-ui/constant': 'targets/reka-ui/packages/core/src/constant/index.ts',
        'reka-ui': 'targets/reka-ui/packages/core/src/index.ts',
      },
      rewriteAlias: { '@/': 'targets/reka-ui/packages/core/src' },
    },
  },

  {
    id: 'vuetify',
    title: 'Vuetify (docs examples over the published library)',
    repo: 'vuetifyjs/vuetify',
    branch: 'master',
    dir: 'targets/vuetify',
    license: MIT('packages/vuetify/LICENSE.md'),
    requires: ['submodule'],
    enabledByDefault: true,
    mode: 'specimen',
    specimen: {
      specimens: ['packages/docs/src/examples/**/*.vue'],
      mutable: ['packages/docs/src/examples/**/*.vue'],
      // Many Vuetify examples ship a `<script setup>` *and* an Options API
      // `<script>` for the docs' "API style" toggle. Those can never compile in
      // Vapor Mode, so mounting them would only measure the virtual DOM.
      requireEligibleRoot: true,
      // The `v-*` components come from the published package, so they are
      // permanently virtual DOM and the bridge is never optional here.
      treeFullyMutable: false,
      setupModule: 'packages/targets/src/setups/vuetify.ts',
    },
    notes:
      'Vapor specimens rendering virtual-DOM Vuetify components: the boundary ' +
      'runs through every slot and every `v-model` the library exposes.',
  },

  {
    id: 'vuetify-jsx',
    title: 'Vuetify (library source, JSX Vapor)',
    repo: 'vuetifyjs/vuetify',
    branch: 'master',
    dir: 'targets/vuetify',
    license: MIT('packages/vuetify/LICENSE.md'),
    requires: ['submodule', 'install'],
    enabledByDefault: false,
    mode: 'specimen',
    specimen: {
      specimens: ['packages/docs/src/examples/**/*.vue'],
      mutable: ['packages/vuetify/src/components/**/*.tsx'],
      requireEligibleRoot: true,
      treeFullyMutable: false,
      setupModule: 'packages/targets/src/setups/vuetify.ts',
      vitePluginsModule: 'packages/targets/src/setups/vuetify-jsx-plugins.ts',
      alias: { vuetify: 'targets/vuetify/packages/vuetify/src/index.ts' },
    },
    notes:
      'Vuetify authors components in TSX, not SFCs, so the component-level ' +
      'switch here is plugin routing (`vue-jsx-vapor` vs `@vitejs/plugin-vue-jsx`) ' +
      'rather than a `vapor` block attribute. Needs the submodule installed and ' +
      'built because the library source pulls in Sass.',
  },

  {
    id: 'nuxt-ui',
    title: 'Nuxt UI v4',
    repo: 'nuxt/ui',
    branch: 'v4',
    dir: 'targets/nuxt-ui',
    license: MIT('LICENSE.md'),
    requires: ['submodule', 'install'],
    enabledByDefault: false,
    mode: 'specimen',
    specimen: {
      specimens: ['docs/app/components/content/examples/**/*.vue'],
      mutable: ['docs/app/components/content/examples/**/*.vue', 'src/runtime/components/**/*.vue'],
      requireEligibleRoot: true,
      treeFullyMutable: true,
      setupModule: 'packages/targets/src/setups/nuxt-ui.ts',
      vitePluginsModule: 'packages/targets/src/setups/nuxt-ui-plugins.ts',
    },
    notes:
      'Mounted through `@nuxt/ui/vue-plugin` (the non-Nuxt entry the repo ships ' +
      'in `playgrounds/vue`), so no Nuxt runtime is involved. Requires ' +
      '`pnpm install && pnpm build` inside the submodule first.',
  },

  {
    id: 'npmx',
    title: 'npmx.dev',
    repo: 'npmx-dev/npmx.dev',
    branch: 'main',
    dir: 'targets/npmx',
    license: MIT('LICENSE'),
    requires: ['submodule', 'install'],
    enabledByDefault: false,
    mode: 'app',
    app: {
      dev: ['pnpm', 'exec', 'nuxt', 'dev', '--port', '5183'],
      port: 5183,
      routes: ['/', '/about', '/accessibility'],
      mutable: ['app/components/**/*.vue', 'app/pages/**/*.vue'],
      appLevelSwitchable: false,
      notes:
        'Nuxt owns `createApp`, so only the component-level switch varies here; ' +
        'the bridge is installed by a generated Nuxt plugin.',
    },
  },

  {
    id: 'elk',
    title: 'Elk',
    repo: 'elk-zone/elk',
    branch: 'main',
    dir: 'targets/elk',
    license: MIT('LICENSE'),
    requires: ['submodule', 'install'],
    enabledByDefault: false,
    mode: 'app',
    app: {
      dev: ['pnpm', 'exec', 'nuxt', 'dev', '--port', '5184'],
      port: 5184,
      routes: ['/', '/settings', '/settings/interface'],
      mutable: ['app/components/**/*.vue', 'app/pages/**/*.vue'],
      appLevelSwitchable: false,
      notes:
        'Most routes need a signed-in Mastodon account; the default route set is ' +
        'restricted to pages that render without one.',
    },
  },

  {
    id: 'misskey',
    title: 'Misskey (frontend)',
    repo: 'misskey-dev/misskey',
    branch: 'develop',
    dir: 'targets/misskey',
    license: {
      id: 'AGPL-3.0-only',
      osiApproved: true,
      modificationGranted: true,
      file: 'LICENSE',
      notes:
        'Copyleft. Modification is granted outright; the network-use clause only ' +
        'bites on conveying a modified version, and mutated sources here never ' +
        'leave `.fuzz/` and are never committed or served publicly.',
    },
    requires: ['submodule', 'install', 'backend'],
    enabledByDefault: false,
    mode: 'app',
    app: {
      dev: ['pnpm', 'run', 'dev'],
      cwd: '.',
      port: 5185,
      routes: ['/', '/about'],
      mutable: ['packages/frontend/src/**/*.vue'],
      appLevelSwitchable: true,
      notes:
        'A plain Vue 3 + Vite SPA (not Nuxt), so `createApp` is in the repo and ' +
        'the app-level switch is real. Needs PostgreSQL + Redis + the backend, ' +
        'which is why it is off by default.',
    },
  },

  {
    id: 'directus',
    title: 'Directus (admin app)',
    repo: 'directus/directus',
    branch: 'main',
    dir: 'targets/directus',
    license: {
      id: 'MSCL-1.0-GPL',
      osiApproved: false,
      modificationGranted: true,
      file: 'license',
      notes:
        'Monospace Sustainable Core License. Not an OSI licence, but it grants ' +
        '"use, copy, modify, create derivative works" for any Permitted Purpose, ' +
        'which explicitly includes non-commercial research and internal use. ' +
        'Off by default so that nobody pulls in a non-OSI dependency unknowingly.',
    },
    requires: ['submodule', 'install', 'backend'],
    enabledByDefault: false,
    mode: 'app',
    app: {
      dev: ['pnpm', 'run', 'dev'],
      cwd: 'app',
      port: 5186,
      routes: ['/admin/login'],
      mutable: ['app/src/**/*.vue'],
      appLevelSwitchable: true,
      notes: 'Needs a running Directus API and database.',
    },
  },
]

export function getTarget(id: string): TargetDefinition {
  const found = TARGETS.find((t) => t.id === id)
  if (!found) {
    throw new Error(`unknown target "${id}". known: ${TARGETS.map((t) => t.id).join(', ')}`)
  }
  return found
}

export function defaultTargets(): readonly TargetDefinition[] {
  return TARGETS.filter((t) => t.enabledByDefault)
}
