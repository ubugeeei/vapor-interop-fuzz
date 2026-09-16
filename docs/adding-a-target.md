# Adding a target

A target is one open-source Vue codebase to fuzz. Adding one is three steps:
vendor it, declare it, and give it whatever the harness needs to render it.

## 1. Check the licence first

The fuzzer **modifies** the code it is pointed at. A target whose licence does
not grant modification has no business in `targets/`, and
`vp run targets:licenses` fails the build if one appears. Non-OSI but
modification-granting licences (Directus' MSCL) are allowed but must be
`enabledByDefault: false`, so nobody pulls one in without meaning to.

If the repository has no LICENSE file at all, there is no grant. That is why
`vuejs-jp/vuefes-2025-website` is not here despite being an ideal Nuxt 4 target.

## 2. Vendor it

```bash
git submodule add --depth 1 -b <branch> https://github.com/<owner>/<repo>.git targets/<id>
```

Then add `shallow = true` under its entry in `.gitmodules`, so CI clones stay
small.

## 3. Declare it

Add an entry to `TARGETS` in `packages/targets/src/registry.ts`. Pick a mode:

### Specimen mode

For component libraries and anything that ships small, self-contained,
prop-free components — docs demos, examples, playground files. The harness owns
the Vite server, which is where all the interesting control lives.

```ts
{
  id: 'my-lib',
  repo: 'owner/my-lib',
  branch: 'main',
  dir: 'targets/my-lib',
  license: { id: 'MIT', osiApproved: true, modificationGranted: true, file: 'LICENSE' },
  requires: ['submodule'],
  enabledByDefault: true,
  mode: 'specimen',
  specimen: {
    specimens: ['docs/examples/**/*.vue'],   // mountable roots
    mutable: ['docs/examples/**/*.vue', 'src/**/*.vue'],  // what may flip
    requireEligibleRoot: true,
    treeFullyMutable: true,
    alias: { 'my-lib': 'targets/my-lib/src/index.ts' },
  },
}
```

Things worth getting right:

- **`treeFullyMutable`** is `true` only when *every* component a specimen
  renders is reachable by the mutator — i.e. the library source is aliased in
  rather than resolved from a prebuilt package. It gates the `pure-vapor`
  shape, which runs with no interop bridge at all and so cannot tolerate a
  single virtual-DOM component anywhere in the tree.
- **Alias order matters.** Vite matches aliases in declaration order and a
  string `find` also matches the `<find>/…` prefix, so subpath entries
  (`my-lib/date`) must come before the bare one. A unit test enforces this.
- **`rewriteAlias`** is for the library's *internal* alias (`@/`). A Vite alias
  satisfies the bundler but not `@vue/compiler-sfc`, which resolves
  `defineProps<T>()` across files by reading the nearest `tsconfig.json`.
  Repositories that keep their real `paths` in a *referenced* tsconfig fail with
  "Failed to resolve extends base type" unless the specifier is rewritten in the
  source.
- **`setupModule`** installs whatever the components need on the app —
  `createVuetify()`, `@nuxt/ui/vue-plugin`. It lives in
  `packages/targets/src/setups/`, which is excluded from `tsconfig.json`
  because it imports code that only exists once that submodule is installed.

Check the discovery before running a campaign:

```bash
vp run fuzz:list
vp run fuzz -- --target my-lib --cases 4 --specimens 2
```

### App mode

For whole applications, where the framework owns `createApp`, the router and
auto-imports, and a component pulled out of the tree will not render. The
harness boots the target's own dev server and drives its real routes.

```ts
{
  id: 'my-app',
  mode: 'app',
  requires: ['submodule', 'install'],
  enabledByDefault: false,
  app: {
    dev: ['pnpm', 'exec', 'nuxt', 'dev', '--port', '5187'],
    port: 5187,
    routes: ['/', '/about'],
    mutable: ['app/components/**/*.vue', 'app/pages/**/*.vue'],
    appLevelSwitchable: false,
  },
}
```

App-mode targets need their own dependency graph:

```bash
vp run targets:install -- my-app
vp run fuzz -- --target my-app --verbose
```

`--verbose` streams the target's dev-server output, which is the only practical
way to debug a target that will not boot.

Set `appLevelSwitchable: false` when the framework creates the app (Nuxt), so
the report does not imply coverage the run never had. Only targets whose own
repository calls `createApp` — Misskey, Directus — can exercise the full
application-level axis.

## 4. If a target is rejected as nondeterministic

Read the reason. The harness distinguishes several cases:

| message | what to do |
| --- | --- |
| `quarantined volatile attribute(s): …` | Nothing — it recovered on its own, and named the blind spot |
| `replaying N of M recorded interactions` | Nothing — it kept the stable prefix |
| `the initial render differs between two identical runs` | The specimen depends on the clock, the network or randomness. Usually correct to drop |
| `control case diverged from the baseline` | Intermittent nondeterminism that survived the double-render check |

A specimen that renders the current month, fetches from a live API, or seeds
from `Math.random()` is genuinely uncomparable, and dropping it is the right
answer. If a *lot* of a target's specimens drop, the target probably wants a
narrower `specimens` glob rather than a looser comparison.
