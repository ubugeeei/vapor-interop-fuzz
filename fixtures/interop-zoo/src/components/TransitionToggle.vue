<script setup lang="ts">
import { ref } from 'vue'

const shown = ref(true)
</script>

<template>
  <div class="transition-toggle">
    <button class="transition-btn" type="button" @click="shown = !shown">toggle</button>
    <Transition name="zoo">
      <p v-if="shown" class="transition-body">visible</p>
    </Transition>
  </div>
</template>

<style scoped>
/* Zero-duration so the enter/leave classes settle within a single frame and
   snapshots stay deterministic. */
.zoo-enter-active,
.zoo-leave-active {
  transition: opacity 0s;
}
.zoo-enter-from,
.zoo-leave-to {
  opacity: 0;
}
</style>
