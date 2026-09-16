<script setup lang="ts">
import { useAttrs } from 'vue'

defineOptions({ inheritAttrs: false })
const attrs = useAttrs()
</script>

<template>
  <div class="attrs-outer" data-owner="passthrough">
    <span class="attrs-count">{{ Object.keys(attrs).length }}</span>
    <button class="attrs-inner" type="button" v-bind="attrs">inner</button>
  </div>
</template>
