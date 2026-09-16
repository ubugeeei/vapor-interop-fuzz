<script setup lang="ts">
import { ref } from 'vue'
import TeleportCard from '../components/TeleportCard.vue'
import AsyncLeaf from '../components/AsyncLeaf.vue'

const open = ref(true)
</script>

<template>
  <main class="spec-teleport">
    <div id="teleport-target" class="teleport-target" />
    <button class="teleport-toggle" type="button" @click="open = !open">toggle</button>

    <TeleportCard v-if="open" to="#teleport-target" label="ported">
      <Suspense>
        <AsyncLeaf label="inside-teleport" />
        <template #fallback><span class="pending">pending</span></template>
      </Suspense>
    </TeleportCard>

    <Suspense>
      <AsyncLeaf label="top-level" />
      <template #fallback><span class="pending">pending</span></template>
    </Suspense>
  </main>
</template>
