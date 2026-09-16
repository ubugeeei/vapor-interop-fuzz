<script setup lang="ts">
import { computed } from 'vue'
import FragmentTriple from './FragmentTriple.vue'
import ExposeCounter from './ExposeCounter.vue'

const props = defineProps<{ which: 'frag' | 'counter' | 'plain' }>()
const target = computed(() =>
  props.which === 'frag' ? FragmentTriple : props.which === 'counter' ? ExposeCounter : 'em',
)
</script>

<template>
  <div class="dynamic-switcher">
    <component :is="target" label="dyn">plain text</component>
  </div>
</template>
