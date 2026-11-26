<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { Bold, Download, FileText, List, LoaderCircle, Pencil } from 'lucide-vue-next';
import { api, message, type ResearchReport } from './api';

const props = defineProps<{ projectId: string; reportId: string }>();
const path = computed(() => props.reportId ? 'projects/' + props.projectId + '/reports/' + props.reportId : '');
const report = ref<ResearchReport | null>(null);
const editor = ref<HTMLElement | null>(null);
const editing = ref(false);
const loading = ref(false);
const saving = ref(false);
const error = ref('');
const drafts = new Map<string, ResearchReport>();
let requestId = 0;

async function loadReport(target: string) {
  const request = ++requestId;
  report.value = null;
  editing.value = false;
  error.value = '';
  loading.value = Boolean(target);
  if (!target) return;
  try {
    const value = await api<ResearchReport>(target);
    if (request !== requestId) return;
    report.value = value;
    if (drafts.has(target)) startEditing();
  } catch (failure) {
    if (request === requestId) error.value = message(failure);
  } finally {
    if (request === requestId) loading.value = false;
  }
}
watch(path, loadReport, { immediate: true });

function startEditing() {
  if (!report.value) return;
  const target = path.value;
  const html = drafts.get(target)?.html ?? report.value.html;
  editing.value = true;
  void nextTick(() => {
    if (!editor.value || target !== path.value) return;
    editor.value.innerHTML = html;
    editor.value.focus();
  });
}

function updateDraft() {
  if (!editor.value || !report.value) return;
  const version = drafts.get(path.value)?.version ?? report.value.version;
  drafts.set(path.value, { html: editor.value.innerHTML, version });
}

function cancelEditing() {
  drafts.delete(path.value);
  editing.value = false;
  error.value = '';
}

function pasteText(event: ClipboardEvent) {
  if (event.clipboardData) document.execCommand('insertText', false, event.clipboardData.getData('text/plain'));
  updateDraft();
}

function format(command: 'bold' | 'insertUnorderedList') {
  editor.value?.focus();
  document.execCommand(command);
  updateDraft();
}

async function save(): Promise<boolean> {
  if (saving.value || !report.value) return false;
  const target = path.value;
  const draft = drafts.get(target);
  if (!draft) {
    editing.value = false;
    return true;
  }
  saving.value = true;
  error.value = '';
  try {
    const updated = await api<ResearchReport>(target, 'PATCH', draft);
    drafts.delete(target);
    if (target !== path.value) return false;
    report.value = updated;
    editing.value = false;
    return true;
  } catch (failure) {
    if (target === path.value) error.value = message(failure);
    return false;
  } finally {
    saving.value = false;
  }
}

function downloadUrl(target: string) {
  return new URL('./api/' + target + '/download', location.href).href;
}

async function saveAndDownload() {
  const target = path.value;
  if (!await save()) return;
  const link = document.createElement('a');
  link.href = downloadUrl(target);
  link.download = '';
  link.click();
}
</script>

<template>
  <section class="result">
    <header class="pane-head result-head">
      <strong id="report-pane-heading" tabindex="-1">{{ editing ? '编辑报告' : '报告预览' }}</strong>
      <div v-if="report" class="preview-actions">
        <template v-if="editing">
          <button class="quiet" type="button" :disabled="saving" @click="cancelEditing">取消编辑</button>
          <button class="primary" type="button" :disabled="saving" @click="save">{{ saving ? '正在保存…' : '保存' }}</button>
          <button type="button" :disabled="saving" @click="saveAndDownload"><Download :size="16" /> 保存并导出 HTML</button>
        </template>
        <template v-else>
          <button type="button" @click="startEditing"><Pencil :size="16" /> 编辑</button>
          <a class="report-download" :href="downloadUrl(path)" download><Download :size="16" /> 导出 HTML</a>
        </template>
      </div>
    </header>
    <div class="result-stage report-stage" role="region" aria-labelledby="report-pane-heading" tabindex="0">
      <p v-if="error" class="error notice" role="alert">{{ error }}
        <button v-if="!report" type="button" @click="loadReport(path)">重试</button>
      </p>
      <div v-if="loading" class="empty-preview" role="status"><LoaderCircle class="spin" :size="24" /> 正在加载报告…</div>
      <div v-else-if="report" class="report-paper">
        <template v-if="editing">
          <div class="report-formatting" role="group" aria-label="文本格式">
            <button type="button" class="quiet" :disabled="saving" @mousedown.prevent @click="format('bold')"><Bold :size="15" /> 加粗</button>
            <button type="button" class="quiet" :disabled="saving" @mousedown.prevent @click="format('insertUnorderedList')"><List :size="16" /> 列表</button>
          </div>
          <article ref="editor" class="report-content report-editor" :contenteditable="!saving" tabindex="0"
            role="textbox" aria-multiline="true" aria-label="报告正文" @input="updateDraft" @paste.prevent="pasteText"
            @drop.prevent @click="($event.target as Element).closest('a') && $event.preventDefault()"
            @auxclick="($event.target as Element).closest('a') && $event.preventDefault()"
            @keydown.ctrl.s.prevent="save" @keydown.meta.s.prevent="save"></article>
        </template>
        <article v-else class="report-content" v-html="report.html"></article>
      </div>
      <div v-else-if="!path" class="empty-preview">
        <span class="large-icon"><FileText :size="26" /></span>
        <h2>选择一份报告</h2><p>点击对话里的报告链接，在这里预览、编辑和导出。</p>
      </div>
    </div>
  </section>
</template>

<style src="./report-content.css"></style>
