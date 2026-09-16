<script setup lang="ts">
defineProps<{ to: string; label: string }>()
</script>

<template>
  <!-- `defer` is required whenever the target is rendered by the same tree:
       without it the target does not exist yet when the Teleport mounts. -->
  <Teleport :to="to" defer>
    <article class="teleport-card">
      <h4>{{ label }}</h4>
      <slot />
    </article>
  </Teleport>
</template>
