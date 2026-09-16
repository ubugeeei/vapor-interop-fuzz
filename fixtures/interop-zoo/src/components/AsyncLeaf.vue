<script setup lang="ts">
const props = defineProps<{ label: string }>()
// Resolved microtask: keeps <Suspense> on the real async path while staying
// fully deterministic for snapshot comparison.
const value = await Promise.resolve(`${props.label}-ready`)
</script>

<template>
  <span class="async-leaf">{{ value }}</span>
</template>
