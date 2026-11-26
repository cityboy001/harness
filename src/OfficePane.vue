<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { Download, LoaderCircle, Plus, Save } from 'lucide-vue-next';
import { api, message } from './api';

type OfficeKind = 'ppt' | 'excel' | 'word';
type OfficeDocument = {
  type: OfficeKind;
  title: string;
  slides?: Array<{ title: string; subtitle?: string; bullets?: string[] }>;
  sheets?: Array<{ name: string; headers: string[]; rows: string[][] }>;
  sections?: Array<{ title: string; paragraphs: string[]; table?: { headers: string[]; rows: string[][] } | null }>;
};

const props = defineProps<{ projectId: string; kind: OfficeKind }>();
const document = ref<OfficeDocument | null>(null);
const raw = ref('');
const loading = ref(true);
const saving = ref(false);
const exporting = ref(false);
const error = ref('');
const saved = ref('');
const activeIndex = ref(0);

const kindLabel = computed(() => props.kind === 'ppt' ? 'PPT' : props.kind === 'excel' ? 'Excel' : 'Word');
const fileLabel = computed(() => props.kind === 'ppt' ? '幻灯片' : props.kind === 'excel' ? '工作表' : '章节');

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const value = await api<{ document: OfficeDocument }>('projects/' + props.projectId + '/office');
    document.value = value.document;
    raw.value = JSON.stringify(value.document, null, 2);
  } catch (loadError) {
    error.value = message(loadError);
  } finally {
    loading.value = false;
  }
}

function syncRaw() {
  if (!document.value) return;
  raw.value = JSON.stringify(document.value, null, 2);
}

async function save() {
  if (!document.value) return;
  saving.value = true;
  saved.value = '';
  error.value = '';
  try {
    document.value = JSON.parse(raw.value) as OfficeDocument;
    if (!document.value?.type || document.value.type !== props.kind) throw new Error('文档类型与当前项目不匹配。');
    const value = await api<{ document: OfficeDocument; version: number }>(
      'projects/' + props.projectId + '/office',
      'PUT',
      { document: document.value }
    );
    document.value = value.document;
    syncRaw();
    saved.value = '已保存';
  } catch (saveError) {
    error.value = saveError instanceof Error ? saveError.message : '保存失败，请检查 JSON 格式。';
  } finally {
    saving.value = false;
  }
}

async function exportFile() {
  exporting.value = true;
  error.value = '';
  try {
    await save();
    if (error.value) return;
    const url = new URL('./api/projects/' + props.projectId + '/office/export', location.href);
    const link = window.document.createElement('a');
    link.href = url.href;
    link.download = '';
    window.document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    exporting.value = false;
  }
}

function addItem() {
  if (!document.value) return;
  if (props.kind === 'ppt') {
    document.value.slides ??= [];
    document.value.slides.push({ title: '新幻灯片', subtitle: '', bullets: ['在这里输入要点'] });
  } else if (props.kind === 'excel') {
    document.value.sheets ??= [];
    document.value.sheets.push({ name: '新工作表', headers: ['列 1', '列 2'], rows: [['', '']] });
  } else {
    document.value.sections ??= [];
    document.value.sections.push({ title: '新章节', paragraphs: ['在这里输入正文。'], table: null });
  }
  activeIndex.value = ((props.kind === 'ppt' ? document.value.slides?.length : props.kind === 'excel' ? document.value.sheets?.length : document.value.sections?.length) ?? 1) - 1;
  syncRaw();
}

watch(() => props.projectId, load);
onMounted(load);
</script>

<template>
  <section class="office-pane">
    <header class="office-toolbar">
      <div>
        <strong>{{ kindLabel }} 文档工作区</strong>
        <span class="meta">{{ fileLabel }}数据可预览、编辑并导出</span>
      </div>
      <div class="office-actions">
        <span v-if="saved" class="success" role="status">{{ saved }}</span>
        <button type="button" :disabled="saving || loading" @click="save"><LoaderCircle v-if="saving" class="spin" :size="16" /><Save v-else :size="16" /> 保存</button>
        <button class="primary" type="button" :disabled="exporting || saving || loading" @click="exportFile"><LoaderCircle v-if="exporting" class="spin" :size="16" /><Download v-else :size="16" /> 导出 {{ kindLabel === 'PPT' ? 'PPTX' : kindLabel === 'Excel' ? 'XLSX' : 'DOCX' }}</button>
      </div>
    </header>

    <p v-if="error" class="error notice" role="alert">{{ error }}</p>
    <div v-if="loading" class="office-loading"><LoaderCircle class="spin" :size="22" /> 正在加载文档…</div>
    <div v-else-if="document" class="office-workspace">
      <aside class="office-outline">
        <label>文档标题
          <input v-model="document.title" @input="syncRaw">
        </label>
        <strong>{{ fileLabel }}列表</strong>
        <template v-if="kind === 'ppt'">
          <button v-for="(slide, index) in document.slides" :key="index" :aria-pressed="activeIndex === index" @click="activeIndex = index">{{ index + 1 }}. {{ slide.title }}</button>
        </template>
        <template v-else-if="kind === 'excel'">
          <button v-for="(sheet, index) in document.sheets" :key="index" :aria-pressed="activeIndex === index" @click="activeIndex = index">{{ sheet.name }}</button>
        </template>
        <template v-else>
          <button v-for="(section, index) in document.sections" :key="index" :aria-pressed="activeIndex === index" @click="activeIndex = index">{{ index + 1 }}. {{ section.title }}</button>
        </template>
        <button type="button" class="quiet" @click="addItem"><Plus :size="16" /> 添加{{ fileLabel }}</button>
      </aside>

      <div class="office-canvas">
        <template v-if="kind === 'ppt'">
          <article v-for="(slide, index) in document.slides" v-show="activeIndex === index" :key="index" class="ppt-slide">
            <input v-model="slide.title" class="ppt-title" aria-label="幻灯片标题" @input="syncRaw">
            <input v-model="slide.subtitle" class="ppt-subtitle" aria-label="幻灯片副标题" @input="syncRaw">
            <textarea :value="(slide.bullets ?? []).join('\n')" aria-label="幻灯片要点" rows="6"
              @input="slide.bullets = (($event.target as HTMLTextAreaElement).value).split('\n'); syncRaw()"></textarea>
          </article>
        </template>

        <template v-else-if="kind === 'excel'">
          <template v-for="(sheet, index) in document.sheets" :key="index">
            <div v-show="activeIndex === index" class="excel-sheet">
              <input v-model="sheet.name" aria-label="工作表名称" @input="syncRaw">
              <table>
                <thead><tr><th v-for="(_, column) in sheet.headers" :key="column">
                  <input v-model="sheet.headers[column]" aria-label="表头" @input="syncRaw">
                </th></tr></thead>
                <tbody>
                  <tr v-for="(row, rowIndex) in sheet.rows" :key="rowIndex">
                    <td v-for="(value, column) in row" :key="column"><input v-model="sheet.rows[rowIndex][column]" @input="syncRaw"></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </template>
        </template>

        <template v-else>
          <article v-for="(section, index) in document.sections" v-show="activeIndex === index" :key="index" class="word-page">
            <input v-model="section.title" class="word-title" aria-label="章节标题" @input="syncRaw">
            <textarea v-for="(paragraph, paragraphIndex) in section.paragraphs" :key="paragraphIndex"
              v-model="section.paragraphs[paragraphIndex]" aria-label="正文段落" rows="4" @input="syncRaw"></textarea>
          </article>
        </template>

        <details class="office-json">
          <summary>查看和编辑文档 JSON</summary>
          <textarea v-model="raw" rows="14" spellcheck="false" aria-label="文档 JSON"></textarea>
        </details>
      </div>
    </div>
  </section>
</template>
