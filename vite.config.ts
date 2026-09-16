import { defineConfig } from 'vite-plus'

/**
 * Single source of truth for the repository's tooling.
 *
 * Everything that would traditionally live in `package.json#scripts`,
 * `vitest.config.ts`, `.oxlintrc.json` or `.prettierrc` is configured here and
 * driven through Vite Task (`vp run <task>`). There are intentionally no npm
 * scripts anywhere in this workspace.
 */
export default defineConfig({
  run: {
    // Fuzzing is nondeterministic by construction: a cache hit would silently
    // turn "we ran 200 random cases" into "we replayed yesterday's log".
    cache: { scripts: false, tasks: true },

    tasks: {
      // --- fuzzing -------------------------------------------------------
      fuzz: {
        command: 'node ./packages/runner/src/bin/vapor-fuzz.ts run',
        cache: false,
      },
      'fuzz:quick': {
        command: 'node ./packages/runner/src/bin/vapor-fuzz.ts run --target interop-zoo --cases 12',
        cache: false,
      },
      'fuzz:replay': {
        command: 'node ./packages/runner/src/bin/vapor-fuzz.ts replay',
        cache: false,
      },
      'fuzz:list': {
        command: 'node ./packages/runner/src/bin/vapor-fuzz.ts list',
        cache: false,
      },

      // --- targets (git submodules) --------------------------------------
      'targets:sync': {
        command: 'git submodule update --init --recursive --depth 1',
        cache: false,
      },
      'targets:install': {
        // App-mode targets are booted through their own dev server, which needs
        // their own dependency graph. Specimen-mode targets do not.
        command: 'node ./packages/runner/src/bin/vapor-fuzz.ts install-target',
        cache: false,
      },
      'targets:licenses': {
        command: 'node ./packages/runner/src/bin/vapor-fuzz.ts licenses',
        cache: false,
      },

      // --- environment ---------------------------------------------------
      'browsers:install': {
        command: 'vp exec playwright install --with-deps chromium',
        cache: false,
      },
    },
  },

  test: {
    // Unit tests for the mutation / normalisation / shrinking logic. The
    // end-to-end browser work is driven by the fuzz runner, not by `vp test`.
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },

  lint: {
    plugins: ['typescript', 'unicorn', 'promise'],
    categories: { correctness: 'error', suspicious: 'warn', perf: 'warn' },
    rules: {
      // The fuzzer is sequential by construction. One dev server holds the
      // current plan in mutable state and one browser page renders it, so two
      // cases cannot be in flight at once -- `Promise.all` here would have them
      // overwrite each other's plan. Every await-in-a-loop in this repository
      // is deliberate.
      'no-await-in-loop': 'off',
      // Vue's own runtime fields (`_ctx`, `app._context`) and Vite's virtual
      // module prefix (`\0`) are underscore-prefixed by design.
      'no-underscore-dangle': 'off',
    },
    ignorePatterns: ['targets/**', '.fuzz/**', 'reports/**', '**/dist/**'],
  },

  fmt: {
    semi: false,
    singleQuote: true,
    ignorePatterns: ['targets/**', '.fuzz/**', 'reports/**', 'pnpm-lock.yaml'],
  },
})
