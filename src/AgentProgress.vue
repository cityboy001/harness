<script setup lang="ts">
import { computed } from 'vue';
import { Check, CircleAlert, LoaderCircle, Minus } from 'lucide-vue-next';
import type { AgentEvent, AgentRole, AgentState, Conversation } from './api';

const props = defineProps<{ events: AgentEvent[]; state: Conversation['state'] }>();
const roles: Record<AgentRole, string> = {
  central: '中央 Agent', frontend: '前端 Agent', backend: '后端 Agent', browser: '浏览器验收',
  direct: '单 Agent', analyze: '分析任务', read_project: '项目调查', edit_project: '项目修改'
};
const states: Record<AgentState | 'stopped' | 'skipped', string> = {
  waiting: '待执行', running: '进行中', done: '已完成', failed: '失败', stopped: '已停止', skipped: '未执行'
};
const actions: Record<string, string> = { inspect: '检查页面', click: '点击', fill: '填写', press: '按键', scroll: '滚动', scroll_until: '滚动直到目标出现', assert_text: '检查可见文本', assert_count: '检查可见元素数量' };
const jobs = computed(() => {
  const active = new Map<string, { key: string; title: string; state: AgentState; task?: string; detail?: string; dependsOn?: string[] }>();
  for (const event of props.events) {
    const key = event.kind === 'check' ? event.role : event.taskId ? 'task:' + event.taskId : event.role;
    const previous = active.get(key);
    const title = (event.kind === 'check' ? undefined : event.title) ?? previous?.title ?? roles[event.role];
    if (event.kind === 'assign') active.set(key, {
      key, title, state: 'waiting', task: event.task, dependsOn: event.dependsOn
    });
    else active.set(key, {
      ...previous, key, title, state: event.state, detail: event.kind === 'status' ? event.detail : undefined
    });
  }
  return [...active.values()].map((job) => ({
    ...job, dependencyTitles: job.dependsOn?.map((id) => active.get('task:' + id)?.title ?? id).join('、'),
    state: props.state !== 'running' && job.state === 'waiting' ? 'skipped' as const
      : props.state !== 'running' && job.state === 'running' ? 'stopped' as const : job.state
  }));
});
const tasks = computed(() => jobs.value.filter((job) => job.task !== undefined));
const phases = computed(() => jobs.value.filter((job) => job.task === undefined));
const completed = computed(() => tasks.value.filter((task) => task.state === 'done').length);
const checkpoints = computed(() => props.events.filter(
  (event): event is Exclude<AgentEvent, { kind: 'status' }> =>
    event.kind === 'check' || (event.kind === 'assign' && event.round > 0)
));
</script>

<template>
  <details class="agent-progress" :open="state === 'running' || state === 'failed'">
    <summary>
      {{ tasks.length ? '任务清单' : 'Agent 进度' }}
      <span v-if="tasks.length" class="agent-tally">已完成 {{ completed }} / {{ tasks.length }}</span>
    </summary>
    <div class="agent-progress-body">
      <ul v-if="phases.length" class="agent-jobs" aria-label="流程状态">
        <li v-for="job in phases" :key="job.key">
          <div class="agent-job-title">
            <strong>{{ job.title }}</strong>
            <span class="agent-state" :data-state="job.state">{{ states[job.state] }}</span>
          </div>
          <p v-if="job.detail && job.state !== 'stopped'" class="agent-detail">{{ job.detail }}</p>
        </li>
      </ul>
      <ul v-if="tasks.length" class="agent-jobs agent-task-list" aria-label="任务清单">
        <li v-for="job in tasks" :key="job.key" class="agent-task">
          <span class="agent-task-mark" :data-state="job.state" aria-hidden="true">
            <Check v-if="job.state === 'done'" :size="14" :stroke-width="2.5" />
            <LoaderCircle v-else-if="job.state === 'running'" class="spin" :size="15" />
            <CircleAlert v-else-if="job.state === 'failed'" :size="15" />
            <Minus v-else-if="job.state === 'stopped'" :size="13" />
          </span>
          <div class="agent-task-copy">
            <div class="agent-job-title">
              <strong>{{ job.title }}</strong>
              <span class="agent-state" :data-state="job.state">{{ states[job.state] }}</span>
            </div>
            <p v-if="job.task">{{ job.task }}</p>
          <p v-if="job.dependencyTitles" class="agent-detail">依赖 {{ job.dependencyTitles }}</p>
          <p v-if="job.detail && job.state !== 'stopped'" class="agent-detail">{{ job.detail }}</p>
          </div>
        </li>
      </ul>
      <ol v-if="checkpoints.length" class="agent-checkpoints" aria-label="验收与修复记录">
        <li v-for="(event, index) in checkpoints" :key="index">
          <template v-if="event.kind === 'assign'">
            <strong v-if="event.role === 'analyze' || event.role === 'read_project'">第 {{ event.round }} 轮追加 · {{ event.title }}</strong>
            <strong v-else>第 {{ event.round }} 轮修复 · 派给{{ event.title ?? roles[event.role] }}</strong>
            <p>{{ event.task }}</p>
          </template>
          <template v-else>
            <strong :class="{ 'danger-text': event.state === 'failed' }">
              {{ event.round ? '第 ' + event.round + ' 轮复测' : '浏览器验收' }}{{ event.state === 'failed' ? '失败' : '通过' }}
            </strong>
            <p v-if="event.step">第 {{ event.step }} 步 · {{ actions[event.action ?? ''] ?? '操作' }} <code v-if="event.selector">{{ event.selector }}</code><template v-if="event.expected"> · 预期看到「{{ event.expected }}」</template></p>
            <p v-if="event.detail && event.state === 'failed'">{{ event.detail }}</p>
          </template>
        </li>
      </ol>
    </div>
  </details>
</template>
