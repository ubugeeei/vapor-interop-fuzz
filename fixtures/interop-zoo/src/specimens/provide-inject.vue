<script setup lang="ts">
import ProvideRoot from '../components/ProvideRoot.vue'
import InjectLeaf from '../components/InjectLeaf.vue'
import SlotHost from '../components/SlotHost.vue'
</script>

<template>
  <main class="spec-provide">
    <ProvideRoot>
      <InjectLeaf />
      <SlotHost title="nested">
        <InjectLeaf />
      </SlotHost>
    </ProvideRoot>

    <!-- outside the provider: must fall back to the defaults -->
    <InjectLeaf />
  </main>
</template>
