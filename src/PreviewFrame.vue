<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import { api, ApiError, type Revision } from './api';
import { createPreviewDocument, previewRoute, previewSandbox, previewStorageUpdate } from './preview-document.js';

const props = defineProps<{ requestPath: string; value: Revision; anonymous?: boolean }>();
const emit = defineEmits<{ expired: [] }>();
const frame = ref<HTMLIFrameElement | null>(null);
const route = ref({ page: 'index.html', search: '' });
const storage: Record<string, string> = Object.create(null);
let channel: MessagePort | undefined;

const srcdoc = createPreviewDocument({ allowExternalImages: true });

function openFrame() {
  channel?.close();
  const { port1, port2 } = new MessageChannel();
  channel = port1;
  const attachedRoute = route.value;
  let active = 0;
  port1.onmessage = async ({ data }) => {
    if (!data || typeof data !== 'object') return;
    if (data.type === 'storage') {
      previewStorageUpdate(storage, data);
      return;
    }
    if (data.type === 'navigate') {
      const next = previewRoute(data, props.value.files);
      if (next && (next.page !== attachedRoute.page || next.search !== attachedRoute.search)) route.value = next;
      return;
    }
    if (data.type !== 'request' || !Number.isSafeInteger(data.id)) return;
    const answer = (status: number, body: unknown) => port1.postMessage({ id: data.id, status, body });
    if (active >= 8) return answer(429, { error: '预览请求过多' });
    active++;
    try {
      const result = await api<{ status: number; body: unknown }>(props.requestPath, 'POST', {
        revision: props.value.revision, method: data.method, path: data.path, query: data.query, body: data.body
      }, props.anonymous);
      answer(result.status, result.body);
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 500;
      answer(status, { error: error instanceof Error ? error.message : '预览请求失败' });
      if (status === 401 || status === 409 || (status === 404 && props.anonymous)) emit('expired');
    } finally {
      active--;
    }
  };
  frame.value?.contentWindow?.postMessage({ type: 'builder-preview', ...attachedRoute, storage, files: { ...props.value.files } }, '*', [port2]);
}

onBeforeUnmount(() => channel?.close());
</script>

<template>
  <iframe :key="route.page + route.search" ref="frame" :title="anonymous ? '项目分享预览' : '项目私有预览'" :sandbox="previewSandbox" referrerpolicy="no-referrer" :srcdoc="srcdoc" @load="openFrame"></iframe>
</template>
