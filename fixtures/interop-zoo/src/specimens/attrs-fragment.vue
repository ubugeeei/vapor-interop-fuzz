<script setup lang="ts">
import { ref } from 'vue'
import AttrsPassthrough from '../components/AttrsPassthrough.vue'
import FragmentTriple from '../components/FragmentTriple.vue'

const clicks = ref(0)
const flag = ref(false)
</script>

<template>
  <main class="spec-attrs">
    <AttrsPassthrough
      id="passthrough-1"
      class="from-parent"
      :data-flag="flag"
      title="tooltip"
      @click="clicks += 1"
    />
    <AttrsPassthrough />

    <button class="toggle-flag" type="button" @click="flag = !flag">flag</button>
    <span class="click-count">{{ clicks }}</span>

    <!-- fragment root with fallthrough attrs: the runtimes have to agree on
         where (or whether) the attributes land -->
    <FragmentTriple label="frag" class="fragment-extra" />
  </main>
</template>
