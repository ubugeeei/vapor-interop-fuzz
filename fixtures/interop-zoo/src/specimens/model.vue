<script setup lang="ts">
import { ref } from 'vue'
import ModelBox from '../components/ModelBox.vue'

const text = ref('seed')
const enabled = ref(false)
const native = ref('native')
const choice = ref('b')
</script>

<template>
  <main class="spec-model">
    <ModelBox v-model:text="text" v-model:enabled="enabled" />
    <ModelBox :text="text" :enabled="enabled" />

    <input class="native-text" type="text" v-model.trim="native" />
    <select class="native-select" v-model="choice">
      <option value="a">a</option>
      <option value="b">b</option>
      <option value="c">c</option>
    </select>

    <pre class="model-state">{{ text }}|{{ enabled }}|{{ native }}|{{ choice }}</pre>
  </main>
</template>
