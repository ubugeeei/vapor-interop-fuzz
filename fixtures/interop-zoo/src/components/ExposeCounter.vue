<script setup lang="ts">
import { ref } from 'vue'

const n = ref(0)
const inc = () => {
  n.value += 1
}
defineExpose({ n, inc })
</script>

<template>
  <span class="expose-counter">{{ n }}</span>
</template>
