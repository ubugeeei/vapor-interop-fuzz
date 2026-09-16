<script setup lang="ts">
const props = defineProps<{ label: string }>()
</script>

<template>
  <span class="frag a">{{ props.label }}-a</span>
  <span class="frag b">{{ props.label }}-b</span>
  <span class="frag c">{{ props.label }}-c</span>
</template>
