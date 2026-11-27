<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ChevronLeft, ChevronRight, Download, FileDown, LoaderCircle, Maximize2, Pencil, Play, Presentation, X } from 'lucide-vue-next';
import { api, message, type PptDeck, type PptDeckRecord, type PptTheme, type PptTransition } from './api';

const SLIDE_W = 1280;
const SLIDE_H = 720;
const THUMB_SCALE = 160 / SLIDE_W;

const props = defineProps<{ projectId: string; deckId: string }>();
const path = computed(() => props.deckId ? 'projects/' + props.projectId + '/ppt/' + props.deckId : '');

const record = ref<PptDeckRecord | null>(null);
const draftDeck = ref<PptDeck | null>(null);
const activeIndex = ref(0);
const editing = ref(false);
const presenting = ref(false);
const loading = ref(false);
const saving = ref(false);
const exporting = ref<'' | 'pptx' | 'pdf'>('');
const error = ref('');

const stageRef = ref<HTMLElement | null>(null);
const presentStageRef = ref<HTMLElement | null>(null);
const presentSlideRef = ref<HTMLElement | null>(null);
const editorSlideRef = ref<HTMLElement | null>(null);
const stageScale = ref(0.5);
const presentScale = ref(1);
const animRunKey = ref(0);
const clickOrders = ref<number[]>([]);
const clickStepIndex = ref(0);

const transitionOptions: { value: PptTransition; label: string }[] = [
  { value: 'fade', label: '淡入淡出' },
  { value: 'push', label: '推入' },
  { value: 'wipe', label: '擦除' },
  { value: 'zoom', label: '缩放' },
  { value: 'none', label: '无切换' }
];

let requestId = 0;
let resizeObserver: ResizeObserver | null = null;

const deck = computed(() => editing.value ? draftDeck.value : record.value?.deck ?? null);
const slides = computed(() => deck.value?.slides ?? []);
const currentSlide = computed(() => slides.value[activeIndex.value] ?? null);
const slideTransitionClass = computed(() => {
  const t = currentSlide.value?.transition ?? 'fade';
  return t && t !== 'none' ? 'ppt-trans-' + t : '';
});
const hasAnimation = computed(() => {
  const slide = currentSlide.value;
  if (!slide) return false;
  return (slide.transition && slide.transition !== 'none') || /data-anim=/.test(slide.html);
});

function replayAnimation() {
  animRunKey.value++;
  if (presenting.value) {
    clickStepIndex.value = 0;
    void nextTick(applyPresentationClickSteps);
  }
}

function applyPresentationClickSteps() {
  const root = presentSlideRef.value;
  if (!root) return;
  const targets = [...root.querySelectorAll<HTMLElement>('[data-anim][data-anim-trigger="click"]')];
  const orders = [...new Set(targets.map(el => Number.parseInt(el.dataset.animOrder || '1', 10) || 1))].sort((a, b) => a - b);
  clickOrders.value = orders;
  const unlockedMax = clickStepIndex.value > 0 ? orders[clickStepIndex.value - 1] ?? 0 : 0;
  for (const el of targets) {
    const order = Number.parseInt(el.dataset.animOrder || '1', 10) || 1;
    if (order > unlockedMax) {
      el.classList.add('ppt-anim-pending');
    } else if (el.classList.contains('ppt-anim-pending')) {
      el.classList.remove('ppt-anim-pending');
      el.style.setProperty('--ppt-anim-delay', '0s');
    }
  }
}

function advancePresentation() {
  if (clickStepIndex.value < clickOrders.value.length) {
    clickStepIndex.value++;
    applyPresentationClickSteps();
    return;
  }
  if (activeIndex.value < slides.value.length - 1) {
    selectSlide(activeIndex.value + 1);
  }
}

function themeStyle(theme: PptTheme): Record<string, string> {
  return {
    '--ppt-primary': theme.primary,
    '--ppt-secondary': theme.secondary,
    '--ppt-surface': theme.surface,
    '--ppt-accent': theme.accent,
    '--ppt-text': theme.text,
    '--ppt-muted': theme.muted,
    '--ppt-on-primary': theme.onPrimary,
    '--ppt-font': theme.fontFamily
  };
}

function updateScale() {
  if (stageRef.value) {
    const pad = 28;
    const availW = Math.max(240, stageRef.value.clientWidth - pad * 2);
    const availH = Math.max(160, stageRef.value.clientHeight - pad * 2);
    stageScale.value = Math.min(availW / SLIDE_W, availH / SLIDE_H, 1);
  }
  if (presenting.value && presentStageRef.value) {
    const availW = Math.max(320, presentStageRef.value.clientWidth - 48);
    const availH = Math.max(200, presentStageRef.value.clientHeight - 88);
    presentScale.value = Math.min(availW / SLIDE_W, availH / SLIDE_H);
  }
}

async function loadDeck(target: string) {
  const request = ++requestId;
  record.value = null;
  draftDeck.value = null;
  editing.value = false;
  error.value = '';
  loading.value = Boolean(target);
  if (!target) return;
  try {
    const value = await api<PptDeckRecord>(target);
    if (request !== requestId) return;
    record.value = value;
    activeIndex.value = Math.min(activeIndex.value, Math.max(0, value.deck.slides.length - 1));
    await nextTick();
    updateScale();
  } catch (failure) {
    if (request === requestId) error.value = message(failure);
  } finally {
    if (request === requestId) loading.value = false;
  }
}

watch(path, loadDeck, { immediate: true });

function syncActiveSlideHtml() {
  if (!editing.value || !draftDeck.value || !editorSlideRef.value) return;
  const slide = draftDeck.value.slides[activeIndex.value];
  if (slide) slide.html = editorSlideRef.value.innerHTML;
}

function mountEditorHtml() {
  void nextTick(() => {
    const slide = draftDeck.value?.slides[activeIndex.value];
    if (!editorSlideRef.value || !slide) return;
    editorSlideRef.value.innerHTML = slide.html;
  });
}

function selectSlide(index: number) {
  if (index < 0 || index >= slides.value.length) return;
  if (editing.value) syncActiveSlideHtml();
  activeIndex.value = index;
  animRunKey.value++;
  clickStepIndex.value = 0;
  if (editing.value) mountEditorHtml();
  else if (presenting.value) void nextTick(applyPresentationClickSteps);
}

function startEditing() {
  if (!record.value) return;
  draftDeck.value = JSON.parse(JSON.stringify(record.value.deck)) as PptDeck;
  editing.value = true;
  error.value = '';
  mountEditorHtml();
}

function cancelEditing() {
  draftDeck.value = null;
  editing.value = false;
  error.value = '';
}

function pastePlainText(event: ClipboardEvent) {
  if (event.clipboardData) {
    document.execCommand('insertText', false, event.clipboardData.getData('text/plain'));
  }
  syncActiveSlideHtml();
}

async function save(): Promise<boolean> {
  if (saving.value || !record.value || !draftDeck.value) return true;
  syncActiveSlideHtml();
  const target = path.value;
  saving.value = true;
  error.value = '';
  try {
    const updated = await api<PptDeckRecord>(target, 'PATCH', {
      version: record.value.version,
      deck: draftDeck.value
    });
    if (target !== path.value) return false;
    record.value = updated;
    draftDeck.value = null;
    editing.value = false;
    activeIndex.value = Math.min(activeIndex.value, Math.max(0, updated.deck.slides.length - 1));
    return true;
  } catch (failure) {
    if (target === path.value) error.value = message(failure);
    return false;
  } finally {
    saving.value = false;
  }
}

async function exportFile(format: 'pptx' | 'pdf') {
  if (exporting.value || !record.value) return;
  if (editing.value && !(await save())) return;
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
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    const title = (record.value.deck.title || '演示文稿').replace(/[\\/:*?"<>|]/g, '_');
    link.download = `${title}.${format}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
  } catch (failure) {
    error.value = message(failure);
  } finally {
    exporting.value = '';
  }
}

async function enterPresentation() {
  if (!deck.value) return;
  if (editing.value && !(await save())) return;
  presenting.value = true;
  animRunKey.value++;
  clickStepIndex.value = 0;
  await nextTick();
  updateScale();
  applyPresentationClickSteps();
  try {
    await presentStageRef.value?.requestFullscreen?.();
  } catch {
    // 浏览器不允许全屏时仍以全屏遮罩模式放映
  }
}

function exitPresentation() {
  presenting.value = false;
  if (document.fullscreenElement) {
    void document.exitFullscreen().catch(() => {});
  }
}

function onKeydown(event: KeyboardEvent) {
  if (presenting.value) {
    if (event.key === 'Escape') {
      exitPresentation();
    } else if (event.key === 'ArrowRight' || event.key === ' ' || event.key === 'PageDown') {
      event.preventDefault();
      advancePresentation();
    } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
      event.preventDefault();
      selectSlide(activeIndex.value - 1);
    }
    return;
  }
  if (editing.value || !slides.value.length) return;
  const tag = (event.target as HTMLElement | null)?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (event.key === 'ArrowRight') selectSlide(activeIndex.value + 1);
  if (event.key === 'ArrowLeft') selectSlide(activeIndex.value - 1);
}

function onFullscreenChange() {
  if (!document.fullscreenElement && presenting.value) {
    presenting.value = false;
  }
  updateScale();
}

onMounted(() => {
  resizeObserver = new ResizeObserver(updateScale);
  if (stageRef.value) resizeObserver.observe(stageRef.value);
  window.addEventListener('resize', updateScale);
  window.addEventListener('keydown', onKeydown);
  document.addEventListener('fullscreenchange', onFullscreenChange);
  updateScale();
});

watch(stageRef, (el, prev) => {
  if (prev) resizeObserver?.unobserve(prev);
  if (el) resizeObserver?.observe(el);
  updateScale();
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  window.removeEventListener('resize', updateScale);
  window.removeEventListener('keydown', onKeydown);
  document.removeEventListener('fullscreenchange', onFullscreenChange);
});
</script>

<template>
  <section class="result ppt-result">
    <header class="pane-head result-head">
      <div class="ppt-head-info">
        <strong id="ppt-pane-heading" tabindex="-1">{{ editing ? '编辑 PPT' : deck?.title || 'PPT 预览' }}</strong>
        <span v-if="slides.length" class="meta">第 {{ activeIndex + 1 }} / {{ slides.length }} 页</span>
      </div>
      <div v-if="deck" class="preview-actions">
        <template v-if="editing">
          <button class="quiet" type="button" :disabled="saving" @click="cancelEditing">取消编辑</button>
          <button class="primary" type="button" :disabled="saving" @click="save">{{ saving ? '正在保存…' : '保存修改' }}</button>
        </template>
        <template v-else>
          <button type="button" class="icon" aria-label="上一页" :disabled="activeIndex <= 0" @click="selectSlide(activeIndex - 1)"><ChevronLeft :size="17" /></button>
          <button type="button" class="icon" aria-label="下一页" :disabled="activeIndex >= slides.length - 1" @click="selectSlide(activeIndex + 1)"><ChevronRight :size="17" /></button>
          <button v-if="hasAnimation" type="button" :disabled="Boolean(exporting)" @click="replayAnimation"><Play :size="15" /> 重播动画</button>
          <button type="button" :disabled="Boolean(exporting)" @click="startEditing"><Pencil :size="15" /> 编辑文字</button>
          <button type="button" :disabled="Boolean(exporting)" @click="enterPresentation"><Maximize2 :size="15" /> 放映</button>
          <button class="primary" type="button" :disabled="Boolean(exporting)" @click="exportFile('pptx')">
            <LoaderCircle v-if="exporting === 'pptx'" class="spin" :size="15" /><Download v-else :size="15" />
            {{ exporting === 'pptx' ? '正在导出…' : '导出 PPTX' }}
          </button>
          <button type="button" :disabled="Boolean(exporting)" @click="exportFile('pdf')">
            <LoaderCircle v-if="exporting === 'pdf'" class="spin" :size="15" /><FileDown v-else :size="15" />
            PDF
          </button>
        </template>
      </div>
    </header>

    <div class="ppt-body-wrap" role="region" aria-labelledby="ppt-pane-heading">
      <p v-if="error" class="error notice" role="alert">
        {{ error }}
        <button v-if="!record && path" type="button" @click="loadDeck(path)">重试</button>
      </p>

      <div v-if="loading" class="empty-preview" role="status"><LoaderCircle class="spin" :size="24" /> 正在加载 PPT…</div>

      <template v-else-if="deck && currentSlide">
        <div v-if="editing" class="ppt-edit-bar">
          <label>页标题
            <input v-model="currentSlide.title" maxlength="120" aria-label="幻灯片标题">
          </label>
          <label class="ppt-transition-field">切页动画
            <select v-model="currentSlide.transition" aria-label="切页动画">
              <option v-for="opt in transitionOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
            </select>
          </label>
          <span class="meta">可直接点击下方画布中的文字修改，按 Ctrl+S 保存</span>
        </div>

        <div ref="stageRef" class="ppt-stage">
          <div class="ppt-canvas-frame"
            :style="{ width: Math.round(SLIDE_W * stageScale) + 'px', height: Math.round(SLIDE_H * stageScale) + 'px' }">
            <section v-if="editing"
              ref="editorSlideRef"
              class="ppt-slide ppt-slide-editable"
              :class="[currentSlide.tone === 'dark' ? 'ppt-slide--dark' : 'ppt-slide--light', 'ppt-template-' + deck.templateId]"
              :style="{ ...themeStyle(deck.theme), transform: 'scale(' + stageScale + ')', transformOrigin: 'top left' }"
              :contenteditable="!saving"
              @input="syncActiveSlideHtml"
              @paste.prevent="pastePlainText"
              @drop.prevent
              @keydown.ctrl.s.prevent="save"
              @keydown.meta.s.prevent="save"
            ></section>
            <section v-else
              :key="currentSlide.index + '-' + animRunKey"
              class="ppt-slide ppt-animate-active"
              :class="[currentSlide.tone === 'dark' ? 'ppt-slide--dark' : 'ppt-slide--light', 'ppt-template-' + deck.templateId, slideTransitionClass]"
              :style="{ ...themeStyle(deck.theme), transform: 'scale(' + stageScale + ')', transformOrigin: 'top left' }"
              v-html="currentSlide.html"
            ></section>
          </div>
        </div>

        <div class="ppt-notes">
          <strong>演讲者备注</strong>
          <textarea v-if="editing" v-model="currentSlide.notes" rows="2" maxlength="2000" placeholder="输入本页演讲备注（导出 PPTX 时自动保留）…"></textarea>
          <p v-else>{{ currentSlide.notes || '暂无演讲备注。' }}</p>
        </div>

        <div class="ppt-thumbs" role="tablist" aria-label="幻灯片缩略图">
          <button v-for="(slide, idx) in slides" :key="slide.index" type="button"
            class="ppt-thumb" :class="{ active: idx === activeIndex }"
            role="tab" :aria-selected="idx === activeIndex"
            @click="selectSlide(idx)">
            <div class="ppt-thumb-viewport">
              <div class="ppt-slide"
                :class="[slide.tone === 'dark' ? 'ppt-slide--dark' : 'ppt-slide--light', 'ppt-template-' + deck.templateId]"
                :style="{ ...themeStyle(deck.theme), transform: 'scale(' + THUMB_SCALE + ')', transformOrigin: 'top left', pointerEvents: 'none' }"
                v-html="slide.html"></div>
            </div>
            <span class="ppt-thumb-label">{{ idx + 1 }}. {{ slide.title }}</span>
          </button>
        </div>
      </template>

      <div v-else-if="!path" class="empty-preview">
        <span class="large-icon"><Presentation :size="26" /></span>
        <h2>尚未生成 PPT</h2>
        <p>在左侧描述主题、受众或页数，Agent 会在浏览器完成排版检查后输出可预览、可编辑、可导出的 PPT。</p>
      </div>
    </div>

    <div v-if="presenting && deck && currentSlide" ref="presentStageRef" class="ppt-present-overlay" tabindex="-1">
      <div class="ppt-present-canvas"
        :style="{ width: Math.round(SLIDE_W * presentScale) + 'px', height: Math.round(SLIDE_H * presentScale) + 'px' }"
        @click="advancePresentation">
        <section ref="presentSlideRef"
          :key="currentSlide.index + '-' + animRunKey"
          class="ppt-slide ppt-animate-active"
          :class="[currentSlide.tone === 'dark' ? 'ppt-slide--dark' : 'ppt-slide--light', 'ppt-template-' + deck.templateId, slideTransitionClass]"
          :style="{ ...themeStyle(deck.theme), transform: 'scale(' + presentScale + ')', transformOrigin: 'top left' }"
          v-html="currentSlide.html"></section>
      </div>
      <div class="ppt-present-controls">
        <button type="button" :disabled="activeIndex <= 0" @click="selectSlide(activeIndex - 1)"><ChevronLeft :size="18" /> 上一页</button>
        <span>{{ activeIndex + 1 }} / {{ slides.length }}</span>
        <button type="button" :disabled="activeIndex >= slides.length - 1 && clickStepIndex >= clickOrders.length" @click="advancePresentation">下一步 <ChevronRight :size="18" /></button>
        <button type="button" @click="exitPresentation"><X :size="18" /> 退出放映</button>
      </div>
    </div>
  </section>
</template>

<style src="./ppt-slide.css"></style>
