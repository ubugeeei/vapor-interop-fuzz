<script setup lang="ts">
import { ref } from 'vue'

const hidden = ref(false)
const vStamp = {
  mounted(el: HTMLElement, binding: { value: string }) {
    el.setAttribute('data-stamp', binding.value)
  },
  updated(el: HTMLElement, binding: { value: string }) {
    el.setAttribute('data-stamp', binding.value)
  },
}
</script>

<template>
  <div class="directive-host">
    <button class="directive-btn" type="button" @click="hidden = !hidden">hide</button>
    <p v-stamp="hidden ? 'off' : 'on'" v-show="!hidden" class="directive-body">stamped</p>
  </div>
</template>
