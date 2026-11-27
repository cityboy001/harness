<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { BookText, Download, FileDown, List, LoaderCircle, Pencil } from 'lucide-vue-next';
import { api, message, type WordDoc, type WordDocRecord, type WordTheme } from './api';

const props = defineProps<{ projectId: string; docId: string }>();
const path = computed(() => props.docId ? 'projects/' + props.projectId + '/word/' + props.docId : '');

const record = ref<WordDocRecord | null>(null);
const draftDoc = ref<WordDoc | null>(null);
const editing = ref(false);
const showOutline = ref(true);
const activeSectionIndex = ref(1);
const loading = ref(false);
const saving = ref(false);
const exporting = ref<'' | 'docx' | 'pdf'>('');
const error = ref('');

const stageRef = ref<HTMLElement | null>(null);
const editorSectionRefs = new Map<number, HTMLElement>();
let requestId = 0;

const doc = computed(() => editing.value ? draftDoc.value : record.value?.doc ?? null);
const sections = computed(() => doc.value?.sections ?? []);
const coverMetaRows = computed(() => {
  const m = doc.value?.meta;
  if (!m) return [];
  return [
    ['撰写单位', m.organization],
    ['撰写人', m.author],
    ['文档编号', m.docNo],
    ['日期', m.date]
  ].filter(([, val]) => val && val.trim());
});

const MARGIN_MAP = {
  narrow: { x: 48, y: 42 },
  normal: { x: 72, y: 62 },
  wide: { x: 94, y: 78 }
};
const TABLE_DENSITY_MAP = {
  compact: { y: 5, x: 8, size: 13 },
  normal: { y: 8, x: 11, size: 14 },
  relaxed: { y: 11, x: 14, size: 14.5 }
};

function themeStyle(theme: WordTheme): Record<string, string> {
  const margin = MARGIN_MAP[theme.pageMargin ?? 'narrow'] ?? MARGIN_MAP.narrow;
  const density = TABLE_DENSITY_MAP[theme.tableDensity ?? 'compact'] ?? TABLE_DENSITY_MAP.compact;
  return {
    '--word-primary': theme.primary,
    '--word-accent': theme.accent,
    '--word-surface': theme.surface,
    '--word-text': theme.text,
    '--word-muted': theme.muted,
    '--word-border': theme.border,
    '--word-font': theme.fontFamily,
    '--word-heading-font': theme.headingFontFamily || theme.fontFamily,
    '--word-font-size': `${theme.fontSize ?? 14.5}px`,
    '--word-line-height': String(theme.lineHeight ?? 1.5),
    '--word-para-gap': `${theme.paragraphSpacing ?? 5}px`,
    '--word-pad-x': `${margin.x}px`,
    '--word-pad-y': `${margin.y}px`,
    '--word-cell-pad-y': `${density.y}px`,
    '--word-cell-pad-x': `${density.x}px`,
    '--word-cell-font-size': `${density.size}px`
  };
}

function docClasses(current: WordDoc): string[] {
  const list = [`word-template-${current.templateId || 'default'}`, `word-heading-${current.theme?.headingStyle || 'underline'}`];
  if (current.theme?.firstLineIndent) list.push('word-indent');
  return list;
}

function setEditorSectionRef(index: number, el: unknown) {
  if (el instanceof HTMLElement) editorSectionRefs.set(index, el);
  else editorSectionRefs.delete(index);
}

async function loadDoc(target: string) {
  const request = ++requestId;
  record.value = null;
  draftDoc.value = null;
  editing.value = false;
  error.value = '';
  loading.value = Boolean(target);
  if (!target) return;
  try {
    const value = await api<WordDocRecord>(target);
    if (request !== requestId) return;
    record.value = value;
    activeSectionIndex.value = value.doc.sections[0]?.index ?? 1;
  } catch (failure) {
    if (request === requestId) error.value = message(failure);
  } finally {
    if (request === requestId) loading.value = false;
  }
}

watch(path, loadDoc, { immediate: true });

function mountEditors() {
  void nextTick(() => {
    if (!draftDoc.value) return;
    for (const sec of draftDoc.value.sections) {
      const el = editorSectionRefs.get(sec.index);
      if (el) el.innerHTML = sec.html;
    }
  });
}

function syncSectionHtml(index: number) {
  if (!editing.value || !draftDoc.value) return;
  const el = editorSectionRefs.get(index);
  const sec = draftDoc.value.sections.find(s => s.index === index);
  if (el && sec) sec.html = el.innerHTML;
}

function startEditing() {
  if (!record.value) return;
  error.value = '';
  draftDoc.value = structuredClone(record.value.doc);
  editing.value = true;
  mountEditors();
}

function cancelEditing() {
  editing.value = false;
  draftDoc.value = null;
  error.value = '';
}

function pastePlainText(event: ClipboardEvent) {
  const text = event.clipboardData?.getData('text/plain');
  if (!text) return;
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) return;
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

async function save() {
  if (!record.value || !draftDoc.value || !path.value || saving.value) return;
  for (const sec of draftDoc.value.sections) syncSectionHtml(sec.index);
  saving.value = true;
  error.value = '';
  try {
    const updated = await api<WordDocRecord>(path.value, 'PATCH', {
      doc: draftDoc.value,
      version: record.value.version
    });
    record.value = updated;
    editing.value = false;
    draftDoc.value = null;
  } catch (failure) {
    error.value = message(failure);
  } finally {
    saving.value = false;
  }
}

function scrollToSection(index: number) {
  activeSectionIndex.value = index;
  const target = stageRef.value?.querySelector<HTMLElement>(`[data-section-index="${index}"]`);
  target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function exportFile(format: 'docx' | 'pdf') {
  if (!path.value || exporting.value) return;
  exporting.value = format;
  error.value = '';
  try {
    const url = new URL('./api/' + path.value + '/export?format=' + format, location.href);
    const response = await fetch(url, { credentials: 'same-origin' });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error || '导出失败，请稍后重试。');
    }
    const blob = await response.blob();
    const link = document.createElement('a');
    const baseName = (record.value?.doc.title || 'document').replace(/[\\/:*?"<>|]/g, '_');
    link.href = URL.createObjectURL(blob);
    link.download = `${baseName}.${format}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 5000);
  } catch (failure) {
    error.value = message(failure);
  } finally {
    exporting.value = '';
  }
}
</script>

<template>
  <section class="result word-result">
    <header class="pane-head result-head">
      <div class="ppt-head-info">
        <strong id="word-pane-heading" tabindex="-1">{{ editing ? '编辑 Word 文档' : doc?.title || 'Word 预览' }}</strong>
        <span v-if="sections.length" class="meta">共 {{ sections.length }} 章</span>
      </div>
      <div v-if="doc" class="preview-actions">
        <template v-if="editing">
          <button class="quiet" type="button" :disabled="saving" @click="cancelEditing">取消编辑</button>
          <button class="primary" type="button" :disabled="saving" @click="save">{{ saving ? '正在保存…' : '保存修改' }}</button>
        </template>
        <template v-else>
          <button type="button" class="quiet" :aria-pressed="showOutline" @click="showOutline = !showOutline"><List :size="15" /> 大纲</button>
          <button type="button" :disabled="Boolean(exporting)" @click="startEditing"><Pencil :size="15" /> 编辑内容</button>
          <button class="primary" type="button" :disabled="Boolean(exporting)" @click="exportFile('docx')">
            <LoaderCircle v-if="exporting === 'docx'" class="spin" :size="15" /><Download v-else :size="15" />
            {{ exporting === 'docx' ? '正在导出…' : '导出 Word' }}
          </button>
          <button type="button" :disabled="Boolean(exporting)" @click="exportFile('pdf')">
            <LoaderCircle v-if="exporting === 'pdf'" class="spin" :size="15" /><FileDown v-else :size="15" />
            PDF
          </button>
        </template>
      </div>
    </header>

    <div class="word-body-wrap" role="region" aria-labelledby="word-pane-heading">
      <p v-if="error" class="error notice" role="alert">
        {{ error }}
        <button v-if="!record && path" type="button" @click="loadDoc(path)">重试</button>
      </p>

      <div v-if="loading" class="empty-preview" role="status"><LoaderCircle class="spin" :size="24" /> 正在加载 Word 文档…</div>

      <template v-else-if="doc">
        <div v-if="editing" class="ppt-edit-bar">
          <label>文档标题
            <input v-model="doc.title" maxlength="120" aria-label="文档标题">
          </label>
          <label>副标题
            <input v-model="doc.subtitle" maxlength="200" aria-label="文档副标题" placeholder="可选副标题">
          </label>
          <span class="meta">可直接点击下方章节正文修改，按 Ctrl+S 保存</span>
        </div>

        <div class="word-workspace-body">
          <aside v-if="showOutline && sections.length" class="word-outline" aria-label="章节大纲">
            <div class="word-outline-title">章节目录</div>
            <button v-for="sec in sections" :key="sec.index" type="button"
              class="word-outline-item" :class="{ active: activeSectionIndex === sec.index }"
              @click="scrollToSection(sec.index)">
              <span class="word-outline-num">{{ String(sec.index).padStart(2, '0') }}</span>
              <span>{{ sec.title }}</span>
            </button>
          </aside>

          <div ref="stageRef" class="word-stage">
            <div class="word-doc" :class="docClasses(doc)" :style="themeStyle(doc.theme)">
              <section v-if="doc.showCover" class="word-sheet word-cover word-paper-card">
                <div class="word-cover-main">
                  <div v-if="doc.meta?.category" class="word-cover-kicker">{{ doc.meta.category }}</div>
                  <h1 class="word-cover-title">{{ doc.title }}</h1>
                  <p v-if="doc.subtitle" class="word-cover-subtitle">{{ doc.subtitle }}</p>
                  <div class="word-cover-rule"></div>
                </div>
                <table v-if="coverMetaRows.length" class="word-cover-meta">
                  <tbody>
                    <tr v-for="[k, v] in coverMetaRows" :key="k">
                      <td>{{ k }}</td>
                      <td>{{ v }}</td>
                    </tr>
                  </tbody>
                </table>
              </section>

              <section v-if="doc.showToc && sections.length >= 2" class="word-sheet word-toc word-paper-card">
                <h2 class="word-toc-title">目录</h2>
                <ol class="word-toc-list">
                  <li v-for="sec in sections" :key="sec.index" class="word-toc-item" @click="scrollToSection(sec.index)">
                    <span class="word-toc-num">{{ String(sec.index).padStart(2, '0') }}</span>
                    <span>{{ sec.title }}</span>
                  </li>
                </ol>
              </section>

              <main class="word-sheet word-paper-card">
                <article v-for="sec in sections" :key="sec.index" class="word-section" :data-section-index="sec.index">
                  <input v-if="editing" v-model="sec.title" class="word-section-heading-input" maxlength="120" :aria-label="'第 ' + sec.index + ' 章标题'">
                  <h1 v-else class="word-section-heading">{{ sec.title }}</h1>
                  <div v-if="editing"
                    :ref="(el) => setEditorSectionRef(sec.index, el)"
                    class="word-section-body word-section-editable"
                    :contenteditable="!saving"
                    @input="syncSectionHtml(sec.index)"
                    @paste.prevent="pastePlainText"
                    @drop.prevent
                    @keydown.ctrl.s.prevent="save"
                    @keydown.meta.s.prevent="save"
                  ></div>
                  <div v-else class="word-section-body" v-html="sec.html"></div>
                </article>
              </main>
            </div>
          </div>
        </div>
      </template>

      <div v-else-if="!path" class="empty-preview">
        <span class="large-icon"><BookText :size="26" /></span>
        <h2>尚未生成 Word 文档</h2>
        <p>在左侧描述文档主题、用途、章节结构或修改意见，Agent 会在浏览器完成 A4 排版检查后输出可预览、可编辑并导出 .docx / .pdf 的正式文档。</p>
      </div>
    </div>
  </section>
</template>

<style src="./word-doc.css"></style>
