<script setup lang="ts">
import type { AcceptanceItem, AcceptanceStatus } from './api';

defineProps<{ items: AcceptanceItem[] }>();
const actions: Record<string, string> = { inspect: '检查页面', click: '点击', fill: '填写', select: '选择下拉选项', press: '按键', scroll: '滚动', scroll_until: '滚动直到目标出现', assert_text: '检查可见文本', assert_count: '检查可见元素数量', assert_layout: '测量布局' };
const acceptanceStates: Record<AcceptanceStatus, string> = {
  passed: '通过', failed: '失败', unverified: '未验证', not_run: '未执行'
};
</script>

<template>
  <ol v-if="items.length" class="agent-checkpoints" aria-label="当前候选逐项验收结果">
    <li v-for="item in items" :key="item.id">
      <strong :class="{ 'danger-text': item.status === 'failed' }">
        {{ item.kind === 'primary' ? '主验收' : '回归检查' }} · {{ item.requirement }} · {{ acceptanceStates[item.status] }}
      </strong>
      <p><code>{{ item.id }}</code> · 预期{{ item.expected }}。{{ item.detail }}</p>
      <p v-for="check in item.checks" :key="check.number">
        第 {{ check.number }} 步 · {{ actions[check.action] }} · {{ acceptanceStates[check.status] }}
        <code v-if="check.selector">{{ check.selector }}</code>
        <template v-if="check.scope"> · 组件 <code>{{ check.scope }}</code></template>
        <template v-if="check.reference"> · 参考 <code>{{ check.reference }}</code></template>
        <template v-if="check.value"> · 「{{ check.value }}」</template>
        <template v-if="check.minCount"> · 至少 {{ check.minCount }} 个</template>
        <template v-if="check.maxCount !== undefined"> · 最多 {{ check.maxCount }} 个</template>
        <template v-if="check.actual || check.baseline">
          · <code>{{ check.metric }}</code>
          <template v-if="check.baseline"> · 基线 {{ check.baseline.value }} px</template>
          <template v-if="check.actual"> · 候选 {{ check.actual.value }} px（{{ check.actual.width }}×{{ check.actual.height }}，{{ check.actual.page }}）</template>
        </template>
        · {{ check.detail }}
      </p>
    </li>
  </ol>
</template>
