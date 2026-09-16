# interop-zoo

The fuzzer's built-in target. Unlike the `targets/*` submodules it needs no
network, no install and no backend, so it is the one target CI always runs.

Its job is to be _dense_: every component here is deliberately built out of a
feature that sits on the Vapor <-> virtual DOM boundary, so that a small number
of cases covers a large amount of interop surface.

| Component                    | Interop surface under test                                           |
| ---------------------------- | -------------------------------------------------------------------- |
| `SlotHost`                   | default / named / scoped slots, slot fallbacks, `<style scoped>` ids |
| `ScopedList`                 | scoped slot inside `v-for`, keyed reordering                         |
| `ModelBox`                   | `defineModel` with multiple named models, native `v-model`           |
| `ProvideRoot` / `InjectLeaf` | `provide`/`inject` across a runtime boundary, injected callbacks     |
| `AttrsPassthrough`           | `inheritAttrs: false`, `useAttrs`, `v-bind="$attrs"`                 |
| `FragmentTriple`             | multi-root component + attribute fallthrough                         |
| `DynamicSwitcher`            | `<component :is>` across component and plain-element targets         |
| `TeleportCard`               | `<Teleport>` / `VaporTeleport`                                       |
| `KeepAliveTabs`              | `<KeepAlive>` / `VaporKeepAlive` with state retention                |
| `AsyncLeaf`                  | top-level `await` under `<Suspense>`                                 |
| `TransitionToggle`           | `<Transition>` / `VaporTransition` enter/leave classes               |
| `DirectiveHost`              | custom directives + `v-show`                                         |
| `ExposeCounter`              | `defineExpose` read through a template ref                           |
| `EmitChain`                  | typed `defineEmits`                                                  |
| `RecursiveTree`              | self-referencing component, deep nesting                             |

Every component is written as `<script setup>` + `<template>`, which is exactly
the shape Vue can compile in Vapor Mode -- so the `pure-vapor` case shape (whole
tree in Vapor, no interop bridge at all) is reachable for this target.
