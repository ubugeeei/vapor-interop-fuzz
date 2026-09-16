<script setup lang="ts">
import { provide, ref } from 'vue'

const hits = ref(0)
provide('zoo:theme', 'midnight')
provide('zoo:depth', 2)
provide('zoo:bump', () => {
  hits.value += 1
})
</script>

<template>
  <div class="provide-root" :data-hits="hits">
    <slot />
  </div>
</template>
