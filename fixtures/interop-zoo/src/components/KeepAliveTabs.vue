<script setup lang="ts">
import { ref } from 'vue'
import ExposeCounter from './ExposeCounter.vue'
import FragmentTriple from './FragmentTriple.vue'

const tab = ref<'left' | 'right'>('left')
</script>

<template>
  <div class="keep-alive-tabs">
    <button class="tab-left" type="button" @click="tab = 'left'">left</button>
    <button class="tab-right" type="button" @click="tab = 'right'">right</button>
    <KeepAlive>
      <ExposeCounter v-if="tab === 'left'" />
      <FragmentTriple v-else label="kept" />
    </KeepAlive>
  </div>
</template>
