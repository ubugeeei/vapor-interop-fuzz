<script setup lang="ts">
interface Node {
  id: string
  children?: Node[]
}

const props = defineProps<{ node: Node; depth?: number }>()
</script>

<template>
  <li class="tree-node" :data-id="props.node.id" :data-depth="props.depth ?? 0">
    {{ props.node.id }}
    <ul v-if="props.node.children?.length">
      <RecursiveTree
        v-for="child in props.node.children"
        :key="child.id"
        :node="child"
        :depth="(props.depth ?? 0) + 1"
      />
    </ul>
  </li>
</template>
