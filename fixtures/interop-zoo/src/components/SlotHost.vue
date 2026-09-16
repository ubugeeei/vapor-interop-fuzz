<script setup lang="ts">
defineProps<{ title: string }>()
</script>

<template>
  <section class="slot-host">
    <header>{{ title }}</header>
    <slot name="lead">lead fallback</slot>
    <div class="body"><slot>default fallback</slot></div>
    <footer><slot name="tail" :count="3" :label="title" /></footer>
  </section>
</template>

<style scoped>
.slot-host {
  border: 1px solid #ccc;
}
</style>
