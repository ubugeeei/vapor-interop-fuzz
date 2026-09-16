<script setup lang="ts">
import { inject } from 'vue'

const theme = inject<string>('zoo:theme', 'unset')
const bump = inject<() => void>('zoo:bump', () => {})
const depth = inject<number>('zoo:depth', -1)
</script>

<template>
  <p class="inject-leaf" :data-theme="theme" :data-depth="depth">
    <button type="button" @click="bump()">bump {{ theme }}</button>
  </p>
</template>
