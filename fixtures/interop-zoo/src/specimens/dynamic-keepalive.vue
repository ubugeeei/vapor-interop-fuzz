<script setup lang="ts">
import { ref } from 'vue'
import DynamicSwitcher from '../components/DynamicSwitcher.vue'
import KeepAliveTabs from '../components/KeepAliveTabs.vue'

const which = ref<'frag' | 'counter' | 'plain'>('frag')
const order: Array<'frag' | 'counter' | 'plain'> = ['frag', 'counter', 'plain']
const cycle = () => {
  which.value = order[(order.indexOf(which.value) + 1) % order.length]!
}
</script>

<template>
  <main class="spec-dynamic">
    <button class="cycle" type="button" @click="cycle">cycle</button>
    <DynamicSwitcher :which="which" />
    <KeepAliveTabs />
  </main>
</template>
