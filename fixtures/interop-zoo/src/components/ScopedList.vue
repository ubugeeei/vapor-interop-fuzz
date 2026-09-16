<script setup lang="ts">
const props = defineProps<{ items: readonly string[] }>()
const upper = (s: string) => s.toUpperCase()
</script>

<template>
  <ul class="scoped-list">
    <li v-for="(item, index) in props.items" :key="item" :data-index="index">
      <slot name="row" :item="item" :index="index" :upper="upper(item)">{{ item }}</slot>
    </li>
  </ul>
</template>
