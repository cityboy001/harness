<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { FileText, LoaderCircle, Trash2, Upload, X } from 'lucide-vue-next';
import { api, message } from './api';

interface KnowledgeFile {
  id: string;
  name: string;
  size: number;
  state: 'uploading' | 'parsing' | 'ready' | 'failed';
  error: string | null;
}

const props = defineProps<{ projectId: string }>();
const path = 'projects/' + props.projectId + '/knowledge/files';
const localTypes = '.txt,.csv';
const mineruTypes = '.xls,.xlsx,.doc,.docx,.ppt,.pptx,.pdf,.png,.jpg,.jpeg,.jp2,.webp,.gif,.bmp';
const status = { uploading: '上传中', parsing: '解析中', ready: '解析完成', failed: '解析失败' };
const picker = ref<HTMLInputElement>();
const files = ref<KnowledgeFile[]>([]);
const mineru = ref(false);
const loading = ref(true);
const uploading = ref(false);
const error = ref('');
const selected = ref<{ id: string; name: string; text: string }>();
const removing = ref('');
const availableSlots = computed(() => 3 - files.value.filter(file => ['uploading', 'parsing'].includes(file.state)).length);
let active = true;
let refreshing = false;
let fileVersion = 0;
let previewRequest = 0;
let timer: ReturnType<typeof setInterval>;

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  const version = fileVersion;
  try {
    const next = await api<{ files: KnowledgeFile[]; mineru: boolean }>(path);
    if (!active) return;
    mineru.value = next.mineru;
    if (version === fileVersion) files.value = next.files;
  } catch (cause) {
    if (active) error.value = message(cause);
  } finally {
    refreshing = false;
    loading.value = false;
  }
}

onMounted(() => {
  void refresh();
  timer = setInterval(() => {
    if (availableSlots.value < 3) void refresh();
  }, 5500);
});
onUnmounted(() => {
  active = false;
  clearInterval(timer);
});

async function uploadFiles(event: Event) {
  const input = event.target as HTMLInputElement;
  const next = [...(input.files ?? [])];
  input.value = '';
  if (!next.length) return;
  if (next.length > availableSlots.value) {
    error.value = '可同时上传 ' + availableSlots.value + ' 个文件。';
    return;
  }
  const errors: string[] = [];
  error.value = '';
  uploading.value = true;
  try {
    for (const file of next) {
      if (!active) break;
      if (file.size > 10 * 1024 * 1024) {
        errors.push(file.name + ' 超过 10 MB。');
        continue;
      }
      try {
        const saved = await api<KnowledgeFile>(path + '?name=' + encodeURIComponent(file.name), 'POST', file);
        if (!active) break;
        fileVersion++;
        files.value = [saved, ...files.value.filter(item => item.id !== saved.id)];
      } catch (cause) {
        errors.push(file.name + '：' + message(cause));
      }
    }
    if (active) error.value = errors.join('\n');
  } finally {
    uploading.value = false;
  }
}

async function view(file: KnowledgeFile) {
  const request = ++previewRequest;
  error.value = '';
  try {
    const document = await api<{ id: string; name: string; text: string }>(path + '/' + file.id);
    if (request === previewRequest) selected.value = document;
  } catch (cause) {
    if (request === previewRequest) error.value = message(cause);
  }
}

async function remove(file: KnowledgeFile) {
  if (!window.confirm('确定从知识库移除「' + file.name + '」？')) return;
  removing.value = file.id;
  error.value = '';
  try {
    await api(path + '/' + file.id, 'DELETE');
    fileVersion++;
    files.value = files.value.filter(item => item.id !== file.id);
    previewRequest++;
    if (selected.value?.id === file.id) selected.value = undefined;
    await refresh();
  } catch (cause) {
    error.value = message(cause);
  } finally {
    removing.value = '';
  }
}
</script>

<template>
  <section class="knowledge-pane" aria-labelledby="knowledge-heading">
    <header class="pane-head">
      <h2 id="knowledge-heading">知识库文件</h2>
      <input ref="picker" type="file" :accept="mineru ? localTypes + ',' + mineruTypes : localTypes"
        multiple hidden @change="uploadFiles">
      <button type="button" class="primary" :disabled="loading || uploading || availableSlots === 0" @click="picker?.click()">
        <LoaderCircle v-if="uploading" :size="16" class="spin" /><Upload v-else :size="16" />
        {{ uploading ? '上传中…' : '上传文件' }}
      </button>
    </header>
    <div class="knowledge-body">
      <p class="description">
        {{ mineru ? 'Excel、Word、PPT、PDF 和图片会发送至 MinerU 解析。TXT 和 CSV 在站内读取。' : '可上传 TXT 和 CSV。其他文件需要配置 MinerU。' }}
        单个文件最多 10 MB。
      </p>
      <p v-if="error" class="error notice" role="alert">{{ error }}</p>
      <p v-if="loading" class="description">正在加载文件…</p>
      <p v-else-if="!files.length" class="description">上传资料后，就可以在对话中提问。</p>
      <ul v-else class="knowledge-files">
        <li v-for="file in files" :key="file.id">
          <FileText :size="18" />
          <div><strong>{{ file.name }}</strong><span class="meta">{{ status[file.state] }}<template v-if="file.error"> · {{ file.error }}</template></span></div>
          <button v-if="file.state === 'ready'" type="button" class="quiet" :aria-label="'查看 ' + file.name" @click="view(file)">查看正文</button>
          <button type="button" class="icon danger-text" :aria-label="'移除 ' + file.name" :disabled="Boolean(removing)" @click="remove(file)"><Trash2 :size="16" /></button>
        </li>
      </ul>
      <section v-if="selected" class="knowledge-text" :aria-label="selected.name">
        <header><h3>{{ selected.name }}</h3><button class="icon" type="button" aria-label="关闭正文" @click="selected = undefined; previewRequest++"><X :size="17" /></button></header>
        <pre>{{ selected.text }}</pre>
      </section>
    </div>
  </section>
</template>
