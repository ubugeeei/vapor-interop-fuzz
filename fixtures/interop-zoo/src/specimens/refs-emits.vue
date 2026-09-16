<script setup lang="ts">
import { ref, useTemplateRef } from 'vue'
import ExposeCounter from '../components/ExposeCounter.vue'
import EmitChain from '../components/EmitChain.vue'

const counter = useTemplateRef<InstanceType<typeof ExposeCounter>>('counter')
const pings = ref(0)
const onPing = (value: number) => {
  pings.value += value
}
const onReset = () => {
  pings.value = 0
}
const poke = () => counter.value?.inc()
</script>

<template>
  <main class="spec-refs">
    <ExposeCounter ref="counter" />
    <button class="poke" type="button" @click="poke">poke</button>
    <EmitChain :step="2" @ping="onPing" @reset="onReset" />
    <span class="pings">{{ pings }}</span>
    <span class="exposed">{{ counter?.n ?? 'nil' }}</span>
  </main>
</template>
