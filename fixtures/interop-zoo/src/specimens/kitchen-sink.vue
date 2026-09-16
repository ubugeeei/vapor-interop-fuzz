<script setup lang="ts">
import { ref } from 'vue'
import ProvideRoot from '../components/ProvideRoot.vue'
import InjectLeaf from '../components/InjectLeaf.vue'
import SlotHost from '../components/SlotHost.vue'
import ScopedList from '../components/ScopedList.vue'
import ModelBox from '../components/ModelBox.vue'
import FragmentTriple from '../components/FragmentTriple.vue'
import RecursiveTree from '../components/RecursiveTree.vue'
import DynamicSwitcher from '../components/DynamicSwitcher.vue'

const text = ref('sink')
const enabled = ref(true)
const items = ref(['one', 'two'])
const which = ref<'frag' | 'counter' | 'plain'>('counter')

const tree = {
  id: 'root',
  children: [
    { id: 'a', children: [{ id: 'a1' }, { id: 'a2' }] },
    { id: 'b', children: [{ id: 'b1', children: [{ id: 'b1x' }] }] },
  ],
}

const grow = () => {
  items.value = [...items.value, `n${items.value.length}`]
}
</script>

<template>
  <ProvideRoot>
    <main class="spec-sink">
      <button class="grow" type="button" @click="grow">grow</button>

      <SlotHost title="sink">
        <template #lead><InjectLeaf /></template>
        <ScopedList :items="items">
          <template #row="{ item, upper }">
            <FragmentTriple :label="upper" />
            <ModelBox v-model:text="text" v-model:enabled="enabled" :data-item="item" />
          </template>
        </ScopedList>
        <template #tail="{ count }">
          <DynamicSwitcher :which="which" />
          <span class="tail-count">{{ count }}</span>
        </template>
      </SlotHost>

      <ul class="tree">
        <RecursiveTree :node="tree" />
      </ul>
    </main>
  </ProvideRoot>
</template>
