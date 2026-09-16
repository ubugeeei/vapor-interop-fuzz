<script setup lang="ts">
const emit = defineEmits<{ ping: [value: number]; reset: [] }>()
const props = defineProps<{ step: number }>()
</script>

<template>
  <span class="emit-chain">
    <button class="emit-ping" type="button" @click="emit('ping', props.step)">ping</button>
    <button class="emit-reset" type="button" @click="emit('reset')">reset</button>
  </span>
</template>
