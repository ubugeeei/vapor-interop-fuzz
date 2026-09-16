<script setup lang="ts">
const text = defineModel<string>('text', { default: '' })
const enabled = defineModel<boolean>('enabled', { default: false })
</script>

<template>
  <fieldset class="model-box">
    <input class="model-text" type="text" v-model="text" />
    <input class="model-flag" type="checkbox" v-model="enabled" />
    <output class="model-echo">{{ text }}/{{ enabled }}</output>
  </fieldset>
</template>
