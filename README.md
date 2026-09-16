# vapor-interop-fuzz

A differential fuzzer for Vue **Vapor Mode ↔ virtual DOM interop**, pointed at
real open-source Vue codebases.

Vue 3.6 lets a single application mix two renderers. A component opts into
Vapor with a `vapor` attribute on its `<script setup>` block, an application
picks its root runtime with `createApp` or `createVaporApp`, and
`vaporInteropPlugin` bridges the two. Every boundary between the two runtimes —
a slot, a `v-model`, an injected value, a fallthrough attribute — is a place
where the two implementations have to agree, and where they can quietly stop
agreeing.

This repository shakes those boundaries loose. It takes a real component tree,
randomly assigns each component to one renderer or the other, renders the
result in a browser, and compares it against the same tree rendered entirely by
the virtual DOM. Any difference is, by construction, an interop difference.

```bash
vp install
vp run browsers:install
vp run fuzz                 # every target enabled by default
vp run fuzz:quick           # the in-repo target only, ~1 minute
```

## How it works

```
                    ┌──────────────────────────────┐
  seed ───────────► │ plan: app mode + vapor set   │
                    └──────────────┬───────────────┘
                                   │
   ┌───────────────────────────────┴────────────────────────────────┐
   │ one Vite dev server per specimen, plan held in mutable state   │
   │                                                                │
   │   pre-transform: add / remove the `vapor` block attribute      │
   │   virtual entry: createApp | createVaporApp (+ bridge or not)  │
   └───────────────────────────────┬────────────────────────────────┘
                                   │
                    ┌──────────────▼───────────────┐
                    │ headless Chromium            │
                    │  · normalised DOM snapshot   │
                    │  · replayed interaction trace│
                    │  · Vue error / warn handlers │
                    └──────────────┬───────────────┘
                                   │
          all-VDOM baseline ──────►│◄────── mutant
                                   │
                            differences ──► shrink ──► report
```

### The two axes

**Component level.** A Vite `transform` hook running before
`@vitejs/plugin-vue` rewrites the `vapor` block attribute on the fly. Nothing
on disk changes, so a submodule's working tree stays clean and two cases can
disagree about the same file with no coordination. The mutator mirrors
`plugin-vue`'s own `canForceVaporMode` rule, so it never flips a component
that could not compile in Vapor Mode anyway.

**Application level.** A generated virtual entry module chooses between four
shapes:

| shape              | root             | bridge | what it proves                              |
| ------------------ | ---------------- | ------ | ------------------------------------------- |
| `pure-vdom`        | `createApp`      | no     | control: must match the baseline exactly    |
| `pure-vapor`       | `createVaporApp` | no     | the whole tree in Vapor renders identically |
| `vdom-root-mixed`  | `createApp`      | yes    | Vapor islands inside a virtual-DOM app      |
| `vapor-root-mixed` | `createVaporApp` | yes    | virtual-DOM islands inside a Vapor app      |

Shapes are paired with mutation strategies that make sense for them, rather
than drawn independently: an unbridged app containing one component of the
other kind is _supposed_ to fail, and nobody wants two hundred copies of that
report. `uniform`, `clustered`, `boundary`, `root-only`, `all` and `none`
control _which_ components flip — `boundary` alternates by import depth, so
almost every parent/child edge in the tree becomes a runtime boundary.

### Making the comparison trustworthy

Differential testing is only as good as its baseline. Most of the harness is
about not crying wolf:

- **Candidates come from the module graph**, not from a glob. After the
  baseline render the runner walks Vite's graph to find the components the
  specimen actually rendered, with their real import depths. A Reka UI demo
  gets its own ~450 components rather than the library's entire catalogue.
- **The baseline is rendered twice.** Anything that differs between two
  identical renders is not an interop bug.
- **Volatile attributes are auto-quarantined.** Vuetify's ripple writes a
  `performance.now()` reading into `data-activated`. If masking exactly the
  attributes that moved makes two identical renders equal, they are masked for
  the rest of the run and _named in the report_. Attributes the comparison
  depends on (`class`, `style`, `id`, form-control state) are never maskable —
  a specimen that is unstable in those is discarded instead.
- **Interaction traces are recorded once and replayed verbatim.** Recomputing
  them per run would mean the first divergence changes what the mutant clicks.
  If later steps are not reproducible even without a mutation, the trace is
  truncated to its longest stable prefix rather than the specimen being thrown
  away.
- **The first case of every specimen is a control** — plain virtual DOM,
  nothing flipped — and it has to match the baseline.
- **Every failure has to reproduce** on a second render with the same
  fingerprint before it is reported.
- **Findings are shrunk** by delta debugging, anchored to the _original_
  symptom: a reduction that fails differently is rejected, so a crash in one
  component is never blamed on another.
- **Known divergences are catalogued** in `packages/core/src/classify.ts` and
  reported separately, so a pervasive understood difference cannot bury a new
  one.

## Targets

Every target is a shallow git submodule under `targets/`, and every one is
listed with the licence that permits modifying it — the fuzzer rewrites the
code it is pointed at, so that question is answered mechanically by
`vp run targets:licenses`, which fails if any target's licence does not grant
modification.

| target        | licence       | mode     | default | notes                                                                         |
| ------------- | ------------- | -------- | ------- | ----------------------------------------------------------------------------- |
| `interop-zoo` | MIT (in-repo) | specimen | ✅      | Hand-written torture fixture; no network, no backend                          |
| `reka-ui`     | MIT           | specimen | ✅      | Library source is aliased in, so its own ~700 SFCs are mutable                |
| `vuetify`     | MIT           | specimen | ✅      | Vapor specimens rendering virtual-DOM Vuetify components                      |
| `vuetify-jsx` | MIT           | specimen | —       | Vuetify is authored in TSX; the switch is `vue-jsx-vapor` vs `plugin-vue-jsx` |
| `nuxt-ui`     | MIT           | specimen | —       | Mounted through `@nuxt/ui/vue-plugin`; needs the submodule built              |
| `npmx`        | MIT           | app      | —       | Nuxt 4                                                                        |
| `elk`         | MIT           | app      | —       | Nuxt 4; most routes need a Mastodon account                                   |
| `misskey`     | AGPL-3.0      | app      | —       | Plain Vue + Vite, so the app-level switch is real; needs a backend            |
| `directus`    | MSCL-1.0-GPL  | app      | —       | **Not OSI.** Grants modification for non-commercial research; opt-in          |

Deliberately excluded: `vuejs-jp/vuefes-2025-website` ships no LICENSE file, so
there is no grant to modify or redistribute it.

**Specimen mode** mounts self-contained components in a Vite app the harness
controls. **App mode** boots the target's own dev server, injecting the
component-level switch and the interop bridge through a generated Nuxt layer
placed inside the submodule and added to its local `info/exclude` — the
target's tracked files are never touched. Nuxt owns `createApp`, so app-level
switching degrades to "virtual-DOM root plus bridge" for Nuxt targets;
`AppConfig.appLevelSwitchable` records that so the report never implies
coverage the run did not have.

## What it has found

Confirmed, shrunk findings from short exploratory runs:

- **The component instance handle is not the same thing in Vapor**, which
  breaks the helpers component libraries build on it. Three symptoms, all from
  Reka UI, all shrunk to one or a few components:
  - `getCurrentInstance()` returns `null` inside a Vapor `setup`, so
    `useForwardExpose`'s `Object.assign({}, instance.exposed)` throws
    `Cannot read properties of null (reading 'exposed')` — minimal reproducer:
    `Label.vue` alone.
  - `$el` is `undefined` on a Vapor instance reached through a template ref, so
    `usePrimitiveElement`'s `primitiveElement.value?.$el.nodeName` throws.
  - `instance.exposed` is missing where the virtual DOM would have populated it.
- **A prop passed across the bridge arrives as slot content.** A Vapor
  specimen rendering Vuetify's `<v-icon icon="mdi-home-outline">` produces
  `<i class="notranslate v-icon">mdi-home-outline</i>` instead of
  `<i class="mdi mdi-home-outline v-icon">`.
- **`TypeError: Cannot define property _ctx, object is not extensible`** in
  `normalizeChildren` — Vapor hands the virtual-DOM renderer a non-extensible
  slots object.
- **Vapor supports only function-form custom directives.** An object directive
  (`{ mounted, updated }`) throws `dir is not a function`; the identical
  component renders fine through the virtual DOM. Catalogued as
  `vapor-object-directive-unsupported`.
- **Vapor emits `data-v-<id>-s` on slot content unconditionally**, where the
  virtual DOM only does so for components whose scoped styles use `:slotted()`.
  Catalogued as `vapor-slotted-scope-id`.

Two API constraints were found and are now encoded rather than re-reported:
`createVaporApp` requires a Vapor root component (it mounts through
`createComponent`, not `createComponentWithFallback`), and an unbridged app
cannot contain a component of the other kind.

## Toolchain

|           |                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------ |
| Runtime   | Node 26, running TypeScript **directly** via native type stripping — no build step for any tool in this repo |
| Types     | TypeScript 7 (`tsgo`); `erasableSyntaxOnly` keeps the source strippable                                      |
| Toolchain | Vite+ (`vp`) — dev server, Vitest, Oxlint, Oxfmt                                                             |
| Tasks     | **Vite Task** (`run.tasks` in `vite.config.ts`). There are no npm scripts anywhere in this workspace         |
| Packages  | pnpm workspace with **catalogs** for every third-party version                                               |
| Config    | Concentrated in `vite.config.ts`: tasks, test, lint and format                                               |

### One wrinkle worth knowing

`@vue/compiler-sfc` resolves `defineProps<T>()` across files itself, and needs
the TypeScript compiler API to do it. `vue/compiler-sfc` auto-registers
`require('typescript')` — which in this workspace is TypeScript 7, whose npm
package exposes neither `sys` nor `createSourceFile` at runtime. Left alone,
every component in a library with a shared base props type fails to compile
with _"Failed to resolve extends base type"_.

So TypeScript 7 stays the type checker, and a classic TypeScript is installed
as `typescript-classic` purely as a library, handed to the SFC compiler through
`registerTS()`. See `packages/runner/src/compiler-ts.ts`.

## Tasks

```bash
vp run fuzz                 # fuzz every default target, write a report
vp run fuzz:quick           # the in-repo fixture only
vp run fuzz:replay -- --seed 12345
vp run fuzz:list            # targets and the specimens discovered for each
vp run targets:sync         # git submodule update --init --depth 1
vp run targets:install -- elk
vp run targets:licenses     # licence matrix; non-zero if any is unclear
vp run browsers:install
vp check                    # format + lint + type check
vp test                     # unit tests
```

Useful flags: `--target <id>` (repeatable), `--cases <n>`, `--specimens <n>`,
`--seed <n>`, `--no-shrink`, `--headed`, `--verbose`, `--actions <n>`.

Every run prints its seed, and a seed plus a target reproduces a campaign
exactly. Reports land in `reports/` as JSON and Markdown; `latest.json` and
`latest.md` are rewritten each run so CI and editors have a stable path.

To confirm a finding by hand:

```bash
node packages/runner/scripts/repro.ts reka-ui \
  targets/reka-ui/docs/components/demo/PinInput/css/index.vue \
  --app-mode vdom-interop \
  targets/reka-ui/packages/core/src/Label/Label.vue
```

## Layout

```
packages/core      mutation, planning, normalisation, diffing, shrinking — no I/O
packages/runner    Vite plugins, dev-server sessions, browser driver, CLI
packages/targets   target registry, licence metadata, per-target glue
fixtures/          the in-repo target
targets/           submodules
```

`packages/core` is deliberately free of I/O, which is why the parts most likely
to produce a wrong answer — the SFC rewriter, the plan generator, the
normaliser, the shrinker — are covered by fast unit tests.

## Limitations

- **App-mode targets are implemented but not exercised in CI.** They need each
  submodule's full dependency graph (`vp run targets:install -- <id>`), and
  `misskey` and `directus` additionally need a database and an API server.
- **Scoped-style and animation differences are compared structurally, not
  visually.** The harness collapses animation _durations_ so that transition
  classes settle deterministically; it does not compare rendered pixels, so a
  purely visual regression with an identical DOM would go unnoticed.
- **Quarantined attributes are blind spots** for the specimen that quarantined
  them. The report names them for that reason.
- **Vue is pinned to 3.6.0-rc.8** in the catalog. Vapor Mode is still an RC;
  some findings here may be fixed upstream by the time you read this, which is
  exactly why the seed is printed for every run.
