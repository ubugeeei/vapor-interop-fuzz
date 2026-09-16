<script setup lang="ts">
import { ref } from 'vue'
import SlotHost from '../components/SlotHost.vue'
import ScopedList from '../components/ScopedList.vue'

const items = ref(['alpha', 'beta', 'gamma'])
const rotate = () => {
  items.value = [...items.value.slice(1), items.value[0]!]
}
</script>

<template>
  <main class="spec-slots">
    <button class="rotate" type="button" @click="rotate">rotate</button>

    <SlotHost title="with everything">
      <template #lead><b>lead</b></template>
      <p>default body</p>
      <template #tail="{ count, label }">tail {{ count }} of {{ label }}</template>
    </SlotHost>

    <SlotHost title="fallbacks only" />

    <ScopedList :items="items">
      <template #row="{ item, index, upper }">
        <code>{{ index }}:{{ upper }}</code>
      </template>
    </ScopedList>

    <ScopedList :items="items" />
  </main>
</template>
