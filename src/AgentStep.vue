<script setup lang="ts">
defineProps<{ title: string; details?: string; elapsed?: string }>();
</script>

<template>
  <details v-if="details" class="agent-step">
    <summary>{{ title }}<span v-if="elapsed" class="agent-tally">{{ elapsed }}</span></summary>
    <p>{{ details }}</p>
  </details>
  <template v-else>
    <strong>{{ title }}</strong><span v-if="elapsed" class="agent-tally">{{ elapsed }}</span>
  </template>
</template>

<style scoped>
.agent-step summary { padding: 0; }
.agent-step p { margin: 4px 0 6px 14px; white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
