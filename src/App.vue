<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import {
  ArrowLeft, Blocks, BookOpen, BookText, Check, ChevronDown, CircleAlert, Code2, Ellipsis, FileCode2, FileText, LayoutGrid,
  Copy, Globe2, Link2, LoaderCircle, LockKeyhole, LogOut, Monitor, Paperclip, Pencil, Play, Plus, Presentation, RotateCw, Send, Settings2,
  Sparkles, Square, Trash2, X
} from 'lucide-vue-next';
import { ApiError, api, message, type ChatAttachment, type Conversation, type Model, type Project, type ProjectChat, type ProjectKind, type ProjectWorkspace, type Revision, type SharedRevision, type ShareLink, type User } from './api';
import PreviewFrame from './PreviewFrame.vue';
import AgentProgress from './AgentProgress.vue';
import ReportPane from './ReportPane.vue';
import PptPane from './PptPane.vue';
import WordPane from './WordPane.vue';
import KnowledgePane from './KnowledgePane.vue';

const conversationPane = ref<HTMLElement | null>(null);
const conversationWidth = ref<number>();
const actualConversationWidth = ref(265);
const workspaceWidth = ref(0);
const draggingDivider = ref(false);
let dividerPointer: number | undefined;
let dividerOffset = 0;

const minimumConversationWidth = 265;
const minimumPreviewWidth = 280;
const dividerWidth = 10;
const maximumConversationWidth = computed(() =>
  Math.max(minimumConversationWidth, Math.floor(workspaceWidth.value - minimumPreviewWidth - dividerWidth)));

watch(conversationPane, (pane, _, onCleanup) => {
  const workspace = pane?.parentElement;
  if (!workspace || !pane) return;
  const syncWidths = () => {
    actualConversationWidth.value = Math.round(pane.getBoundingClientRect().width);
    workspaceWidth.value = workspace.getBoundingClientRect().width;
  };
  const observer = new ResizeObserver(syncWidths);
  observer.observe(workspace);
  observer.observe(pane);
  syncWidths();
  onCleanup(() => {
    observer.disconnect();
    dividerPointer = undefined;
    draggingDivider.value = false;
  });
});

function resizeConversation(width: number) {
  conversationWidth.value = Math.min(maximumConversationWidth.value, Math.max(minimumConversationWidth, Math.round(width)));
}

function startDividerDrag(event: PointerEvent) {
  if (event.button !== 0 || dividerPointer !== undefined) return;
  const divider = event.currentTarget as HTMLElement;
  divider.setPointerCapture(event.pointerId);
  divider.focus({ preventScroll: true });
  dividerPointer = event.pointerId;
  dividerOffset = event.clientX - divider.getBoundingClientRect().left;
  draggingDivider.value = true;
}

function moveDivider(event: PointerEvent) {
  if (dividerPointer !== event.pointerId) return;
  const workspace = (event.currentTarget as HTMLElement).parentElement;
  if (workspace) resizeConversation(event.clientX - workspace.getBoundingClientRect().left - dividerOffset);
}

function endDividerDrag(event: PointerEvent) {
  if (dividerPointer !== event.pointerId) return;
  dividerPointer = undefined;
  draggingDivider.value = false;
}

function resizeDividerByKey(event: KeyboardEvent) {
  const currentWidth = conversationPane.value?.getBoundingClientRect().width ?? actualConversationWidth.value;
  const widths: Record<string, number> = {
    ArrowLeft: currentWidth - 24,
    ArrowRight: currentWidth + 24,
    Home: minimumConversationWidth,
    End: maximumConversationWidth.value
  };
  if (!Object.hasOwn(widths, event.key)) return;
  event.preventDefault();
  resizeConversation(widths[event.key]);
}

const user = ref<User | null>(null);
const initialized = ref(false);
const authMode = ref<'login' | 'register'>('register');
const username = ref('');
const password = ref('');
const projects = ref<Project[]>([]);
const projectCategory = ref<ProjectKind | 'all'>('all');
const current = ref<Project | null>(null);
const reportId = ref('');
const researchSearchAvailable = ref(false);
const chats = ref<ProjectChat[]>([]);
const selectedChat = ref('');
const creatingChat = ref(false);
const loadingChat = ref(false);
const activeGeneration = ref<ProjectWorkspace['activeGeneration']>(null);
const chatDrafts = new Map<string, string>();
const history = ref<Conversation[]>([]);
const models = ref<Model[]>([]);
const platform = ref<Model | null>(null);
const selectedModel = ref('platform');
const prompt = ref('');
const tab = ref<'preview' | 'source'>('preview');
const source = ref<Revision | null>(null);
const sourceFile = ref('');
const preview = ref<Revision | null>(null);
const previewReload = ref(0);
const previewError = ref('');
const workspaceError = ref('');
const pollError = ref('');
const pageError = ref('');
const busy = ref(false);
const starting = ref(false);
const sending = ref(false);
const stopping = ref(false);
const name = ref('');
const modal = ref<'create' | 'rename' | 'delete' | 'models' | 'share' | 'attachment' | null>(null);
const newProjectKind = ref<ProjectKind>('website');
const modalError = ref('');
const modelFeedback = ref('');
const target = ref<Project | null>(null);
const modelDraft = ref({ id: '', name: '', baseUrl: '', model: '', key: '' });
const thread = ref<HTMLElement | null>(null);
const nameInput = ref<HTMLInputElement | null>(null);
const shareInput = ref<HTMLInputElement | null>(null);
const attachmentPicker = ref<HTMLInputElement | null>(null);
const attachments = ref<ChatAttachment[]>([]);
const attachmentMineru = ref(false);
const attachmentUploading = ref(false);
const attachmentError = ref('');
const attachmentDragging = ref(false);
const removingAttachment = ref('');
const previewAttachment = ref<{ id: string; name: string; text: string; thumbnail?: string | null } | null>(null);
let attachmentToken = 0;
let attachmentVersion = 0;
let attachmentRefreshing = false;
let dragDepth = 0;
const attachmentSizeLimit = 10 * 1024 * 1024;
const localAttachmentAccept = '.txt,.md,.csv,.tsv,.json,.xml,.yaml,.yml,.log';
const mineruAttachmentAccept = '.xls,.xlsx,.doc,.docx,.ppt,.pptx,.pdf,.png,.jpg,.jpeg,.jp2,.webp,.gif,.bmp';
const attachmentStatusLabel: Record<ChatAttachment['state'], string> = {
  uploading: '上传中',
  parsing: '解析中',
  ready: '已就绪',
  failed: '解析失败'
};
const pasteMimeExt: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'text/csv': '.csv',
  'application/pdf': '.pdf'
};
const shareToken = new URL(location.href).searchParams.get('share');
const sharedPath = 'shares/' + encodeURIComponent(shareToken ?? '');
const sharedPage = ref<SharedRevision | null>(null);
const sharedError = ref('');
const shareLink = ref<ShareLink | null>(null);
const shareFeedback = ref('');
let poll: ReturnType<typeof setInterval> | undefined;
let polling: symbol | undefined;
let viewToken = 0;
let renderToken = 0;

const running = computed(() => Boolean(activeGeneration.value));
const runningInAnotherChat = computed(() => activeGeneration.value !== null && (activeGeneration.value.chat_id ?? '') !== selectedChat.value);
const customModels = computed(() => models.value.filter((model) => model.source === 'custom'));
const research = computed(() => current.value?.kind === 'research');
const ppt = computed(() => current.value?.kind === 'ppt');
const word = computed(() => current.value?.kind === 'word');
const knowledge = computed(() => current.value?.kind === 'knowledge');
const supportsAttachments = computed(() => Boolean(current.value && current.value.kind !== 'knowledge'));
const attachmentAccept = computed(() => attachmentMineru.value ? localAttachmentAccept + ',' + mineruAttachmentAccept : localAttachmentAccept);
const pendingAttachmentCount = computed(() => attachments.value.filter((item) => item.state === 'uploading' || item.state === 'parsing').length);
const hasPendingAttachments = computed(() => attachmentUploading.value || pendingAttachmentCount.value > 0);
const projectCategories = [
  { kind: 'website', title: '网站项目', icon: Globe2, createLabel: '新建项目', emptyLabel: '还没有网站项目' },
  { kind: 'research', title: '调研报告', icon: FileText, createLabel: '新建调研', emptyLabel: '还没有调研报告' },
  { kind: 'ppt', title: 'PPT 演示文稿', icon: Presentation, createLabel: '新建 PPT', emptyLabel: '还没有演示文稿' },
  { kind: 'word', title: 'Word 文档', icon: BookText, createLabel: '新建 Word 文档', emptyLabel: '还没有 Word 文档' },
  { kind: 'knowledge', title: '知识库问答', icon: BookOpen, createLabel: '新建知识库', emptyLabel: '还没有知识库' }
] as const;
const projectGroups = computed(() => projectCategories.map((category) => ({
  ...category, items: projects.value.filter((item) => item.kind === category.kind)
})));
const visibleProjectGroups = computed(() => projectGroups.value.filter((group) =>
  projectCategory.value === 'all' || projectCategory.value === group.kind));
const workspaceModels = computed(() => current.value && current.value.kind !== 'website' ? models.value.filter((model) => model.source !== 'demo') : models.value);
const activeModel = computed(() => workspaceModels.value.find((model) => model.id === selectedModel.value) ?? platform.value);
const fileNames = computed(() => Object.keys(source.value?.files ?? {}).sort());
const sourceText = computed(() => source.value?.files[sourceFile.value] ?? '');
const sourceLineNumbers = computed(() => sourceText.value.split(/\r\n|\n|\r/).map((_, index) => index + 1).join('\n'));
const demoModel = computed(() => models.value.find((model) => model.source === 'demo'));

function formatDate(value: number) {
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(value);
}
function stateLabel(item: Project) {
  if (item.draftRevision) return '候选预览';
  if (item.hasSavedDraft && !item.revision) return '候选已保存';
  if (item.preview === 'running') return '运行中';
  if (item.preview === 'starting') return '启动中';
  return item.revision ? '预览已停止' : '草稿';
}
function modelLabel(model: Model) {
  if (model.source === 'platform') return model.name + ' · 平台额度' + (model.available ? '' : '（未配置）');
  if (model.source === 'demo') return model.name + ' · 离线样例';
  return model.name + ' · 自带 Key';
}
function scrollThread() {
  void nextTick(() => { if (thread.value) thread.value.scrollTop = thread.value.scrollHeight; });
}
function workspaceUrl(id?: string, chat = '', report = '') {
  const url = new URL(location.href);
  if (id) url.searchParams.set('project', id);
  else url.searchParams.delete('project');
  if (id && chat) url.searchParams.set('chat', chat);
  else url.searchParams.delete('chat');
  if (id && report) url.searchParams.set('report', report);
  else url.searchParams.delete('report');
  return url;
}
function setUrl(id?: string, replace = false, chat = '', report = '') {
  const url = workspaceUrl(id, chat, report);
  if (url.href !== location.href) window.history[replace ? 'replaceState' : 'pushState'](null, '', url);
}
function openReport(id: string) {
  if (!current.value) return;
  reportId.value = id;
  setUrl(current.value.id, false, selectedChat.value, id);
  void nextTick(() => document.getElementById(ppt.value ? 'ppt-pane-heading' : word.value ? 'word-pane-heading' : 'report-pane-heading')?.focus());
}
function resetWorkspace() {
  viewToken++;
  renderToken++;
  attachmentToken++;
  attachmentVersion = 0;
  attachmentRefreshing = false;
  dragDepth = 0;
  current.value = null;
  reportId.value = '';
  selectedChat.value = '';
  chats.value = [];
  activeGeneration.value = null;
  creatingChat.value = false;
  loadingChat.value = false;
  chatDrafts.clear();
  history.value = [];
  attachments.value = [];
  attachmentMineru.value = false;
  attachmentUploading.value = false;
  attachmentError.value = '';
  attachmentDragging.value = false;
  removingAttachment.value = '';
  previewAttachment.value = null;
  source.value = null;
  sourceFile.value = '';
  preview.value = null;
  previewError.value = '';
  workspaceError.value = '';
  pollError.value = '';
  prompt.value = '';
  starting.value = false;
  sending.value = false;
  stopping.value = false;
  tab.value = 'preview';
}
function formatFileSize(bytes: number) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
function attachmentApiPath(projectId: string, chatId: string, name?: string) {
  const params = new URLSearchParams();
  if (chatId) params.set('chat', chatId);
  if (name) params.set('name', name);
  const query = params.toString();
  return 'projects/' + projectId + '/attachments' + (query ? '?' + query : '');
}
async function loadAttachments(force = false) {
  const project = current.value;
  if (!project || project.kind === 'knowledge') return;
  if (attachmentRefreshing && !force) return;
  attachmentRefreshing = true;
  const token = attachmentToken;
  const projectId = project.id;
  const chatId = selectedChat.value;
  const version = attachmentVersion;
  try {
    const result = await api<{ files: ChatAttachment[]; mineru: boolean }>(attachmentApiPath(projectId, chatId));
    if (token !== attachmentToken || current.value?.id !== projectId || selectedChat.value !== chatId) return;
    attachmentMineru.value = result.mineru;
    if (version === attachmentVersion) attachments.value = result.files;
  } catch (error) {
    if (token === attachmentToken && current.value?.id === projectId && selectedChat.value === chatId) {
      attachmentError.value = message(error);
    }
  } finally {
    if (token === attachmentToken) attachmentRefreshing = false;
  }
}
function normalizeAttachmentName(file: File, index: number) {
  const raw = (file.name || '').trim();
  const mimeExt = pasteMimeExt[file.type.toLowerCase()] || '';
  const isGenericImage = file.type.startsWith('image/') && (!raw || /^(?:image|blob|screenshot)\.[a-z0-9]+$/i.test(raw) || !raw.includes('.'));
  if (isGenericImage) {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
    const ext = mimeExt || (raw.includes('.') ? raw.slice(raw.lastIndexOf('.')).toLowerCase() : '.png');
    return `粘贴图片-${stamp}${index > 0 ? '-' + (index + 1) : ''}${ext}`;
  }
  if (raw && !raw.includes('.') && mimeExt) return raw + mimeExt;
  return raw || `附件-${Date.now()}${mimeExt}`;
}
function isImageAttachment(file: File, fileName: string) {
  return file.type.startsWith('image/') || /\.(?:png|jpe?g|webp|gif|bmp)$/i.test(fileName);
}
async function createImageThumbnail(file: File): Promise<string | null> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('decode failed'));
      el.src = url;
    });
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    if (!width || !height) return null;
    for (const [maxEdge, quality] of [[360, 0.82], [240, 0.72], [180, 0.65]] as const) {
      const scale = Math.min(1, maxEdge / Math.max(width, height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const webp = canvas.toDataURL('image/webp', quality);
      const dataUrl = webp.startsWith('data:image/webp;') ? webp : canvas.toDataURL('image/jpeg', quality);
      if (dataUrl.length <= 56000) return dataUrl;
    }
    return null;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
async function uploadAttachmentFiles(fileList: File[]) {
  const project = current.value;
  if (!project || project.kind === 'knowledge' || !fileList.length) return;
  const token = attachmentToken;
  const projectId = project.id;
  const chatId = selectedChat.value;
  const errors: string[] = [];
  attachmentError.value = '';
  attachmentUploading.value = true;
  try {
    for (let i = 0; i < fileList.length; i++) {
      if (token !== attachmentToken || current.value?.id !== projectId || selectedChat.value !== chatId) break;
      const file = fileList[i];
      const fileName = normalizeAttachmentName(file, i);
      if (!file.size) {
        errors.push(fileName + ' 为空文件。');
        continue;
      }
      if (file.size > attachmentSizeLimit) {
        errors.push(fileName + ' 超过 10 MB 限制。');
        continue;
      }
      try {
        const thumbnail = isImageAttachment(file, fileName) ? await createImageThumbnail(file) : null;
        const saved = await api<ChatAttachment>(attachmentApiPath(projectId, chatId, fileName), 'POST', file);
        if (token !== attachmentToken || current.value?.id !== projectId || selectedChat.value !== chatId) break;
        if (thumbnail) {
          saved.thumbnail = thumbnail;
          void api('projects/' + projectId + '/attachments/' + saved.id + '/thumbnail', 'PATCH', { thumbnail }).catch(() => {});
        }
        attachmentVersion++;
        attachments.value = [...attachments.value.filter((item) => item.id !== saved.id), saved];
      } catch (error) {
        errors.push(fileName + '：' + message(error));
      }
    }
    if (token === attachmentToken && current.value?.id === projectId && selectedChat.value === chatId) {
      attachmentError.value = errors.join('\n');
    }
  } finally {
    if (token === attachmentToken) attachmentUploading.value = false;
  }
}
function onAttachmentInput(event: Event) {
  const input = event.target as HTMLInputElement;
  const picked = [...(input.files ?? [])];
  input.value = '';
  if (picked.length) void uploadAttachmentFiles(picked);
}
function onComposerPaste(event: ClipboardEvent) {
  if (!supportsAttachments.value || !event.clipboardData) return;
  const pasted: File[] = [];
  if (event.clipboardData.files.length) {
    pasted.push(...event.clipboardData.files);
  } else {
    for (const item of event.clipboardData.items) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) pasted.push(file);
      }
    }
  }
  if (!pasted.length) return;
  event.preventDefault();
  void uploadAttachmentFiles(pasted);
}
function onComposerDragEnter(event: DragEvent) {
  if (!supportsAttachments.value || !event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  dragDepth++;
  attachmentDragging.value = true;
}
function onComposerDragOver(event: DragEvent) {
  if (!supportsAttachments.value || !event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
}
function onComposerDragLeave(event: DragEvent) {
  if (!supportsAttachments.value) return;
  event.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) attachmentDragging.value = false;
}
function onComposerDrop(event: DragEvent) {
  if (!supportsAttachments.value) return;
  event.preventDefault();
  dragDepth = 0;
  attachmentDragging.value = false;
  const dropped = [...(event.dataTransfer?.files ?? [])];
  if (dropped.length) void uploadAttachmentFiles(dropped);
}
async function openAttachmentPreview(file: ChatAttachment) {
  const project = current.value;
  if (!project || file.state !== 'ready') return;
  attachmentError.value = '';
  try {
    previewAttachment.value = await api<{ id: string; name: string; text: string; thumbnail?: string | null }>('projects/' + project.id + '/attachments/' + file.id);
    modal.value = 'attachment';
  } catch (error) {
    attachmentError.value = message(error);
  }
}
async function removeAttachment(file: ChatAttachment) {
  const project = current.value;
  if (!project || removingAttachment.value) return;
  removingAttachment.value = file.id;
  attachmentError.value = '';
  try {
    await api('projects/' + project.id + '/attachments/' + file.id, 'DELETE');
    attachmentVersion++;
    attachments.value = attachments.value.filter((item) => item.id !== file.id);
    if (previewAttachment.value?.id === file.id) {
      previewAttachment.value = null;
      if (modal.value === 'attachment') modal.value = null;
    }
  } catch (error) {
    attachmentError.value = message(error);
  } finally {
    removingAttachment.value = '';
  }
}
async function initialize() {
  try {
    const snapshot = await api<{ user: User | null; platform: Model }>('session');
    platform.value = snapshot.platform;
    user.value = snapshot.user;
    if (user.value) await enterAccount();
  } catch (error) {
    pageError.value = message(error);
  } finally {
    initialized.value = true;
  }
}
async function openSharedPage() {
  sharedError.value = '';
  try {
    sharedPage.value = await api<SharedRevision>(sharedPath, 'GET', undefined, true);
    document.title = sharedPage.value.name + ' · 分享预览';
    previewReload.value++;
  } catch (error) {
    sharedPage.value = null;
    sharedError.value = message(error);
  } finally {
    initialized.value = true;
  }
}
async function manageShare(action: 'open' | 'create' | 'revoke') {
  if (!current.value || busy.value) return;
  const path = 'projects/' + current.value.id + '/share';
  if (action === 'open') {
    shareLink.value = null;
    modal.value = 'share';
  }
  busy.value = true;
  modalError.value = '';
  shareFeedback.value = '';
  try {
    if (action === 'revoke') {
      await api(path, 'DELETE');
      shareLink.value = null;
      shareFeedback.value = '分享链接已撤销。';
    } else {
      const data = action === 'open'
        ? await api<{ share: ShareLink | null }>(path)
        : await api<{ share: ShareLink }>(path, 'POST', {});
      shareLink.value = data.share;
    }
  } catch (error) {
    modalError.value = message(error);
  } finally {
    busy.value = false;
  }
}
async function copyShare() {
  if (!shareLink.value) return;
  try {
    await navigator.clipboard.writeText(shareLink.value.url);
    shareFeedback.value = '链接已复制。';
  } catch {
    shareInput.value?.focus();
    shareInput.value?.select();
    shareFeedback.value = '链接已选中，可以手动复制。';
  }
}

async function enterAccount() {
  await Promise.all([loadProjects(), loadModels()]);
  await restoreRoute();
}
async function loadProjects() { projects.value = await api<Project[]>('projects'); }
async function loadModels() {
  models.value = await api<Model[]>('models');
  platform.value = models.value.find((model) => model.source === 'platform') ?? null;
  if (!models.value.some((model) => model.id === selectedModel.value)) selectedModel.value = 'platform';
}
async function authenticate() {
  busy.value = true;
  pageError.value = '';
  try {
    const result = await api<{ user: User }>(authMode.value, 'POST', { name: username.value, password: password.value });
    user.value = result.user;
    password.value = '';
    selectedModel.value = 'platform';
    await enterAccount();
  } catch (error) {
    password.value = '';
    pageError.value = message(error);
  } finally {
    busy.value = false;
  }
}
async function signOut() {
  try {
    await api('logout', 'POST', {});
    user.value = null;
    authMode.value = 'login';
    resetWorkspace();
    projects.value = [];
    projectCategory.value = 'all';
    models.value = [];
    setUrl(undefined, true);
  } catch (error) {
    (current.value ? workspaceError : pageError).value = message(error);
  }
}
async function restoreRoute() {
  if (!user.value) return;
  const route = new URL(location.href).searchParams;
  const id = route.get('project');
  const chat = route.get('chat') ?? '';
  const report = route.get('report') ?? '';
  if (id && current.value?.id === id) {
    if (chat && !chats.value.some((item) => item.id === chat)) setUrl(id, true, selectedChat.value);
    else {
      await selectChat(chat, false);
      showLinkedReport(report);
    }
  } else if (id) await openProject(id, false, chat, report);
  else {
    resetWorkspace();
    await loadProjects();
  }
}
function workspaceData(id: string, chat: string) {
  return api<ProjectWorkspace>('projects/' + id + (chat ? '?chat=' + encodeURIComponent(chat) : ''));
}
function updateWorkspace(result: ProjectWorkspace) {
  current.value = result.project;
  researchSearchAvailable.value = result.researchSearchAvailable;
  chats.value = result.chats;
  activeGeneration.value = result.activeGeneration;
  history.value = result.messages;
}
function showLinkedReport(id: string) {
  const targetType = research.value ? 'report' : ppt.value ? 'ppt' : word.value ? 'word' : null;
  const items = targetType ? history.value.filter(item => item.result_type === targetType) : [];
  reportId.value = items.find(item => item.id === id)?.id ?? items.at(-1)?.id ?? '';
}
async function openProject(id: string, updateUrl = true, chat = '', report = '') {
  if (current.value?.id === id) return;
  resetWorkspace();
  pageError.value = '';
  const token = viewToken;
  try {
    const result = await workspaceData(id, chat).catch((error) => {
      if (!chat || !(error instanceof ApiError) || error.status !== 404) throw error;
      chat = '';
      return workspaceData(id, chat);
    });
    if (viewToken !== token || !user.value) return;
    selectedChat.value = chat;
    updateWorkspace(result);
    if (result.project.kind !== 'website' && selectedModel.value === 'demo') selectedModel.value = 'platform';
    showLinkedReport(report);
    setUrl(id, !updateUrl, chat, reportId.value);
    if (result.project.kind !== 'knowledge') void loadAttachments(true);
    if (result.project.preview === 'running' || result.project.draftRevision) await loadPreview();
    scrollThread();
  } catch (error) {
    if (viewToken !== token) return;
    pageError.value = message(error);
    setUrl(undefined, true);
  }
}
async function selectChat(chat: string, updateUrl = true) {
  const id = current.value?.id;
  if (!id || selectedChat.value === chat) return;
  chatDrafts.set(selectedChat.value, prompt.value);
  selectedChat.value = chat;
  reportId.value = '';
  prompt.value = chatDrafts.get(chat) ?? '';
  history.value = [];
  workspaceError.value = '';
  attachmentToken++;
  attachmentVersion = 0;
  attachmentRefreshing = false;
  attachments.value = [];
  attachmentError.value = '';
  loadingChat.value = true;
  if (updateUrl) setUrl(id, false, chat);
  void loadAttachments(true);
  await refreshWorkspace(true);
}
async function createChat() {
  const id = current.value?.id;
  if (!id || creatingChat.value) return;
  const token = viewToken;
  creatingChat.value = true;
  workspaceError.value = '';
  try {
    const chat = await api<ProjectChat>('projects/' + id + '/chats', 'POST', {});
    if (token !== viewToken) return;
    if (!chats.value.some((item) => item.id === chat.id)) chats.value = [chat, ...chats.value];
    await selectChat(chat.id);
  } catch (error) {
    if (token === viewToken) workspaceError.value = message(error);
  } finally {
    if (token === viewToken) creatingChat.value = false;
  }
}
async function back() {
  resetWorkspace();
  setUrl();
  try { await loadProjects(); } catch (error) { pageError.value = message(error); }
}
async function refreshWorkspace(force = false) {
  const id = current.value?.id;
  if (!id || (polling && !force)) return;
  const token = viewToken;
  const chat = selectedChat.value;
  const request = Symbol();
  polling = request;
  try {
    const result = await workspaceData(id, chat);
    if (token !== viewToken || polling !== request) return;
    pollError.value = '';
    const changed = result.project.revision !== current.value?.revision;
    const changedDraft = result.project.draftRevision !== current.value?.draftRevision;
    const differentStatus = result.project.preview !== current.value?.preview;
    const changedHistory = result.messages.length !== history.value.length || result.messages.at(-1)?.state !== history.value.at(-1)?.state;
    const changedAgentEvents = result.messages.at(-1)?.agent_events?.length !== history.value.at(-1)?.agent_events?.length;
    const atBottom = thread.value && thread.value.scrollHeight - thread.value.scrollTop - thread.value.clientHeight < 36;
    const previousLastDoc = (ppt.value || word.value)
      ? history.value.filter(item => item.result_type === (ppt.value ? 'ppt' : 'word')).at(-1)?.id
      : '';
    updateWorkspace(result);
    if (research.value && !reportId.value) {
      showLinkedReport('');
      if (reportId.value) setUrl(id, true, chat, reportId.value);
    }
    if (ppt.value || word.value) {
      const latestDoc = history.value.filter(item => item.result_type === (ppt.value ? 'ppt' : 'word')).at(-1)?.id ?? '';
      if (latestDoc && (!reportId.value || latestDoc !== previousLastDoc)) {
        reportId.value = latestDoc;
        setUrl(id, true, chat, latestDoc);
      }
    }
    if (changedHistory || (changedAgentEvents && atBottom)) scrollThread();
    if (changed || differentStatus || changedDraft) {
      if (result.project.preview === 'running' || result.project.draftRevision) await loadPreview();
      else preview.value = null;
      if (changed && tab.value === 'source') await loadSource();
    }
  } catch (error) {
    if (token === viewToken && polling === request) {
      pollError.value = error instanceof ApiError && error.status === 0
        ? '暂时无法刷新对话，正在自动重连。' : message(error);
    }
  } finally {
    if (polling === request) {
      polling = undefined;
      if (token === viewToken) loadingChat.value = false;
    }
  }
}
async function loadPreview() {
  const id = current.value?.id;
  const token = ++renderToken;
  if (!id) return;
  previewError.value = '';
  try {
    const result = await api<Revision>('projects/' + id + '/preview');
    if (token !== renderToken) return;
    preview.value = result;
    previewReload.value++;
  } catch (error) {
    if (token !== renderToken) return;
    previewError.value = message(error);
  }
}
async function loadSource() {
  const id = current.value?.id;
  const token = viewToken;
  if (!id || !current.value?.revision) return;
  try {
    const result = await api<Revision>('projects/' + id + '/source');
    if (token !== viewToken) return;
    source.value = result;
    if (!Object.hasOwn(result.files, sourceFile.value)) sourceFile.value = 'index.html';
  } catch (error) {
    if (token === viewToken) workspaceError.value = message(error);
  }
}
function setTab(next: 'preview' | 'source') {
  tab.value = next;
  if (next === 'source' && source.value?.revision !== current.value?.revision) void loadSource();
}
async function runPreview(start: boolean, draft = false) {
  if (!current.value) return;
  const token = viewToken;
  starting.value = true;
  previewError.value = '';
  try {
    const updated = await api<Project>('projects/' + current.value.id + '/preview/' + (start ? 'start' : 'stop'), 'POST', { draft });
    if (token !== viewToken) return;
    current.value = updated;
    if (start || updated.preview === 'running' || updated.draftRevision) await loadPreview();
    else { renderToken++; preview.value = null; }
  } catch (error) {
    if (token === viewToken) previewError.value = message(error);
  } finally {
    if (token === viewToken) starting.value = false;
  }
}
function sendOnEnter(event: KeyboardEvent) {
  if (event.shiftKey || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  if (!event.repeat && activeModel.value?.available && !hasPendingAttachments.value) void generate();
}

async function generate(value = prompt.value, retryModel?: string, resumeMessageId?: string) {
  if (!current.value || running.value || sending.value || loadingChat.value || hasPendingAttachments.value || !value.trim()) return;
  const token = viewToken;
  const chatId = selectedChat.value;
  sending.value = true;
  workspaceError.value = '';
  const modelId = retryModel && workspaceModels.value.some((model) => model.id === retryModel && model.available) ? retryModel : activeModel.value?.id;
  try {
    await api('projects/' + current.value.id + '/generate', 'POST', { prompt: value.trim(), modelId, chatId: chatId || null, resumeMessageId });
    if (token !== viewToken) return;
    if (!retryModel) {
      chatDrafts.delete(chatId);
      if (chatId === selectedChat.value) {
        prompt.value = '';
        if (supportsAttachments.value) {
          attachmentVersion++;
          attachments.value = attachments.value.filter((item) => item.state !== 'ready');
        }
      }
    }
    await refreshWorkspace(true);
  } catch (error) {
    if (token === viewToken) workspaceError.value = message(error);
  } finally {
    if (token === viewToken) sending.value = false;
  }
}
async function stopGeneration() {
  const item = activeGeneration.value;
  if (!current.value || !item || stopping.value) return;
  const token = viewToken;
  stopping.value = true;
  workspaceError.value = '';
  try {
    await api('projects/' + current.value.id + '/messages/' + item.id + '/stop', 'POST', {});
    if (token === viewToken) await refreshWorkspace(true);
  } catch (error) {
    if (token === viewToken) workspaceError.value = message(error);
  } finally {
    if (token === viewToken) stopping.value = false;
  }
}
function sample() {
  if (!demoModel.value) return;
  selectedModel.value = demoModel.value.id;
  prompt.value = current.value?.revision ? '添加按完成状态筛选。' : '做一个待办网站，可以新增、编辑和完成任务，刷新后保留记录。';
}

function projectModal(kind: 'create' | 'rename' | 'delete', item?: Project, projectKind: ProjectKind = 'website') {
  modalError.value = '';
  modal.value = kind;
  target.value = item ?? null;
  newProjectKind.value = projectKind;
  name.value = item?.name ?? '';
  if (kind !== 'delete') void nextTick(() => nameInput.value?.focus());
}
function closeModal() {
  if (busy.value) return;
  modal.value = null;
  modelDraft.value.key = '';
  previewAttachment.value = null;
}
async function saveProject() {
  busy.value = true;
  modalError.value = '';
  const targetId = target.value?.id;
  try {
    if (modal.value === 'delete' && targetId) {
      await api('projects/' + targetId, 'DELETE');
      if (current.value?.id === targetId) await back();
      else await loadProjects();
    } else if (modal.value === 'rename' && targetId) {
      const result = await api<Project>('projects/' + targetId, 'PATCH', { name: name.value });
      if (current.value?.id === targetId) current.value = result;
      else await loadProjects();
    } else {
      const result = await api<Project>('projects', 'POST', { name: name.value, kind: newProjectKind.value });
      await openProject(result.id);
    }
    modal.value = null;
  } catch (error) {
    modalError.value = message(error);
  } finally {
    busy.value = false;
  }
}
function editModel(model?: Model) {
  modalError.value = '';
  modelFeedback.value = '';
  modelDraft.value = model
    ? { id: model.id, name: model.name, baseUrl: model.baseUrl || '', model: model.model, key: '' }
    : { id: '', name: '', baseUrl: '', model: '', key: '' };
}
function showModels() {
  editModel();
  modal.value = 'models';
}
async function modelAction(action: 'test' | 'save' | 'delete') {
  busy.value = true;
  modalError.value = '';
  modelFeedback.value = '';
  const { id, ...fields } = modelDraft.value;
  try {
    if (action === 'test') {
      await api('models/test', 'POST', { id, ...fields });
      modelFeedback.value = '连接成功。';
    } else if (action === 'delete' && id) {
      await api('models/' + id, 'DELETE');
      await loadModels();
      editModel();
      modelFeedback.value = '模型配置已删除。';
    } else {
      const result = await api<Model>('models' + (id ? '/' + id : ''), id ? 'PUT' : 'POST', fields);
      await loadModels();
      editModel(result);
      selectedModel.value = result.id;
      modelFeedback.value = '已保存并选用该模型。';
    }
  } catch (error) {
    modalError.value = message(error);
  } finally {
    busy.value = false;
  }
}
function routeChanged() { void restoreRoute().catch((error) => { pageError.value = message(error); }); }
onMounted(() => {
  if (shareToken !== null) {
    void openSharedPage();
    return;
  }
  void initialize();
  poll = setInterval(() => {
    void refreshWorkspace();
    if (supportsAttachments.value && pendingAttachmentCount.value > 0) void loadAttachments();
  }, 1500);
  window.addEventListener('popstate', routeChanged);
});
onUnmounted(() => {
  clearInterval(poll);
  window.removeEventListener('popstate', routeChanged);
});
</script>

<template>
  <main v-if="shareToken !== null" class="shared-page">
    <header class="topbar">
      <div class="brand"><span class="brand-icon"><Globe2 :size="20" /></span>{{ sharedPage?.name || '分享预览' }}</div>
      <button v-if="sharedPage" class="quiet" @click="openSharedPage"><RotateCw :size="16" /> 刷新预览</button>
    </header>
    <div v-if="!initialized" class="loading"><LoaderCircle class="spin" :size="22" /> 正在打开预览</div>
    <div v-else-if="sharedPage" class="result-stage">
      <PreviewFrame :key="previewReload" :request-path="sharedPath + '/request'" :value="sharedPage" anonymous @expired="openSharedPage" />
    </div>
    <div v-else class="empty-preview">
      <span class="large-icon"><Link2 :size="25" /></span>
      <h1>无法打开分享预览</h1><p role="alert">{{ sharedError }}</p>
    </div>
  </main>
  <div v-else class="app-shell" :class="{ 'has-workspace': current }">
    <header class="topbar">
      <div v-if="current" class="breadcrumbs">
        <button class="quiet back" type="button" @click="back"><ArrowLeft :size="17" /> 我的项目</button>
        <span class="slash">/</span><strong>{{ current.name }}</strong>
        <details class="menu project-menu">
          <summary class="icon" aria-label="项目操作"><Ellipsis :size="19" /></summary>
          <div class="menu-items">
            <button @click="projectModal('rename', current); ($event.currentTarget as HTMLElement).closest('details')?.removeAttribute('open')"><Pencil :size="15" /> 重命名</button>
            <button class="danger-text" @click="projectModal('delete', current); ($event.currentTarget as HTMLElement).closest('details')?.removeAttribute('open')"><Trash2 :size="15" /> 删除项目</button>
          </div>
        </details>
      </div>
      <div v-else class="brand"><span class="brand-icon"><Blocks :size="20" /></span> 建站工作台</div>
      <div v-if="user" class="top-actions">
        <span v-if="current" class="private"><LockKeyhole :size="14" /> 工作区仅自己可见</span>
        <details class="menu user-menu">
          <summary class="account" aria-label="账号菜单"><span class="avatar">{{ user.name.slice(0, 1).toUpperCase() }}</span><ChevronDown :size="14" /></summary>
          <div class="menu-items">
            <strong>{{ user.name }}</strong>
            <button @click="showModels(); ($event.currentTarget as HTMLElement).closest('details')?.removeAttribute('open')"><Settings2 :size="16" /> 模型设置</button>
            <button @click="signOut"><LogOut :size="16" /> 退出登录</button>
          </div>
        </details>
      </div>
    </header>

    <div v-if="!initialized" class="loading"><LoaderCircle class="spin" :size="24" /> 正在打开工作台</div>
    <main v-else-if="!user" class="auth-wrap">
      <div class="auth-card">
        <span class="large-icon"><Sparkles :size="24" /></span>
        <h1>{{ authMode === 'register' ? '创建账号' : '登录工作台' }}</h1>
        <p>用对话生成、修改和预览你的网站。</p>
        <form class="stack" @submit.prevent="authenticate">
          <label>用户名<input v-model="username" autocomplete="username" required minlength="2" maxlength="24" placeholder="输入用户名"></label>
          <label>密码<input v-model="password" type="password" :autocomplete="authMode === 'register' ? 'new-password' : 'current-password'" required :minlength="authMode === 'register' ? 6 : 1" maxlength="128" :placeholder="authMode === 'register' ? '至少 6 个字符' : '输入密码'"></label>
          <p v-if="pageError" class="error" role="alert">{{ pageError }}</p>
          <button class="primary" :disabled="busy" type="submit">{{ busy ? '请稍候…' : authMode === 'register' ? '注册并进入' : '登录' }}</button>
        </form>
        <div class="auth-switch">
          {{ authMode === 'register' ? '已有账号？' : '还没有账号？' }}
          <button class="link" @click="authMode = authMode === 'register' ? 'login' : 'register'; pageError = ''">{{ authMode === 'register' ? '去登录' : '去注册' }}</button>
        </div>
      </div>
    </main>

    <main v-else-if="!current" class="projects">
      <aside class="project-sidebar">
        <h2 id="project-categories">项目分类</h2>
        <nav aria-labelledby="project-categories">
          <button type="button" :aria-pressed="projectCategory === 'all'" @click="projectCategory = 'all'">
            <LayoutGrid :size="17" /> 全部项目 <span>{{ projects.length }}</span>
          </button>
          <button v-for="group in projectGroups" :key="group.kind" type="button"
            :aria-pressed="projectCategory === group.kind" @click="projectCategory = group.kind">
            <component :is="group.icon" :size="17" /> {{ group.title }} <span>{{ group.items.length }}</span>
          </button>
        </nav>
      </aside>
      <div class="project-content">
        <header class="project-heading"><h1>我的项目</h1></header>
        <p v-if="pageError" class="error notice" role="alert">{{ pageError }}</p>
        <div class="project-grid" :class="{ 'single-category': projectCategory !== 'all' }">
          <section v-for="group in visibleProjectGroups" :key="group.kind" class="project-category"
            :data-kind="group.kind" :aria-labelledby="'category-' + group.kind">
            <header class="project-category-header">
              <span class="project-icon"><component :is="group.icon" :size="20" /></span>
              <h2 :id="'category-' + group.kind">{{ group.title }}</h2>
              <button :class="{ primary: group.kind === 'website' }" type="button" @click="projectModal('create', undefined, group.kind)">
                <Plus :size="16" /> {{ group.createLabel }}
              </button>
            </header>
            <div v-if="group.items.length" class="project-list">
              <article v-for="item in group.items" :key="item.id" class="project-row">
                <button class="project-entry" @click="openProject(item.id)"><strong>{{ item.name }}</strong><span>{{ formatDate(item.updated) }} 更新</span></button>
                <span v-if="item.kind === 'website'" class="status" :class="item.preview"><i></i>{{ stateLabel(item) }}</span>
                <details class="menu row-menu">
                  <summary class="icon" :aria-label="item.name + ' 项目操作'"><Ellipsis :size="19" /></summary>
                  <div class="menu-items">
                    <button @click="projectModal('rename', item); ($event.currentTarget as HTMLElement).closest('details')?.removeAttribute('open')"><Pencil :size="15" /> 重命名</button>
                    <button class="danger-text" @click="projectModal('delete', item); ($event.currentTarget as HTMLElement).closest('details')?.removeAttribute('open')"><Trash2 :size="15" /> 删除项目</button>
                  </div>
                </details>
              </article>
            </div>
            <p v-else class="empty-projects">{{ group.emptyLabel }}</p>
          </section>
        </div>
      </div>
    </main>

    <main v-else class="workspace" :class="{ 'resizing-workspace': draggingDivider, 'knowledge-workspace': knowledge }"
      :style="{ '--conversation-width': conversationWidth === undefined ? undefined : conversationWidth + 'px' }">
      <aside id="conversation-pane" ref="conversationPane" class="conversation">
        <header class="pane-head chat-head">
          <strong>{{ knowledge ? '知识库问答' : research ? '调研对话' : ppt ? 'PPT 对话' : word ? 'Word 对话' : '建站对话' }}</strong>
          <select :value="selectedChat" aria-label="切换对话" @change="selectChat(($event.target as HTMLSelectElement).value)">
            <option value="">默认对话</option>
            <option v-for="chat in chats" :key="chat.id" :value="chat.id">{{ chat.title }}</option>
          </select>
          <button class="quiet" type="button" :disabled="creatingChat" @click="createChat"><Plus :size="16" /> 新建对话</button>
        </header>
        <div ref="thread" class="thread" aria-live="polite">
          <p v-if="loadingChat" class="meta">正在加载对话…</p>
          <div v-else-if="!history.length" class="empty-thread">
            <span class="large-icon"><Sparkles :size="22" /></span>
            <h2>{{ knowledge ? '想从资料中了解什么？' : research ? '你想了解什么？' : ppt ? '想做什么主题的 PPT？' : word ? '想撰写什么 Word 文档？' : current.revision ? '这次想做什么？' : '你想做什么网站？' }}</h2>
            <p>{{ knowledge ? '文件解析完成后，可以提问并查看答案引用的原文。' : research ? '可以直接提问，也可以让助手调研并生成带来源的报告。' : ppt ? '描述主题、受众、页数或风格要求，Agent 会先在浏览器完成排版检查再输出。' : word ? '描述文档主题、用途、章节或内容要求，Agent 会先完成 A4 排版检查再输出。' : current.revision ? '可以提问，也可以继续修改当前网站。' : '说说要实现的功能，生成后可以继续在这里修改。' }}</p>
          </div>
          <div v-for="item in history" :key="item.id" class="message-pair">
            <div class="user-turn">
              <div v-if="item.attachments?.length" class="message-attachments" aria-label="本轮附带文件">
                <button v-for="file in item.attachments" :key="file.id" type="button"
                  class="message-attachment" :class="{ 'is-image': Boolean(file.thumbnail) }"
                  :title="file.name + '（点击查看解析内容）'" @click="openAttachmentPreview(file)">
                  <img v-if="file.thumbnail" :src="file.thumbnail" :alt="file.name" class="message-attachment-thumb">
                  <template v-else>
                    <FileText :size="15" />
                    <span class="message-attachment-name">{{ file.name }}</span>
                  </template>
                </button>
              </div>
              <div class="user-message">{{ item.prompt }}</div>
            </div>
            <div class="ai-message">
              <span class="ai-icon"><Sparkles :size="15" /></span>
              <div>
                <span class="meta">{{ item.model_name }} · {{ item.state === 'running' ? '处理中' : item.state === 'failed' ? '处理失败' : item.state === 'stopped' ? '已停止' : item.result_type === 'answer' ? '已回复' : '已生成' }}</span>
                <a v-if="item.result_type === 'report'" class="report-link"
                  :href="workspaceUrl(current.id, selectedChat, item.id).href"
                  :aria-current="reportId === item.id ? 'true' : undefined"
                  @click.left.exact.prevent="openReport(item.id)"><FileText :size="16" /> 查看调研报告</a>
                <a v-else-if="item.result_type === 'ppt'" class="report-link"
                  :href="workspaceUrl(current.id, selectedChat, item.id).href"
                  :aria-current="reportId === item.id ? 'true' : undefined"
                  @click.left.exact.prevent="openReport(item.id)"><Presentation :size="16" /> 查看 PPT</a>
                <a v-else-if="item.result_type === 'word'" class="report-link"
                  :href="workspaceUrl(current.id, selectedChat, item.id).href"
                  :aria-current="reportId === item.id ? 'true' : undefined"
                  @click.left.exact.prevent="openReport(item.id)"><BookText :size="16" /> 查看 Word 文档</a>
                <div v-if="item.state === 'failed'" class="generation-error">
                  <p class="danger-text" role="alert"><CircleAlert :size="16" aria-hidden="true" /><span>{{ item.response }}</span></p>
                  <button class="quiet retry" :disabled="running || sending" @click="generate(item.prompt, item.model_id, item.has_checkpoint ? item.id : undefined)"><RotateCw :size="14" /> {{ item.has_checkpoint ? '继续修改候选' : '重试' }}</button>
                </div>
                <AgentProgress v-if="item.agent_events?.length"
                  :events="item.agent_events ?? []" :state="item.state" />
                <p v-if="item.state === 'running'" class="in-progress"><LoaderCircle class="spin" :size="16" /> {{ item.agent_progress || '正在处理你的请求…' }}</p>
                <p v-else-if="item.state !== 'failed' && item.response">{{ item.response }}</p>
                <button v-if="item.state === 'stopped'" class="quiet retry" :disabled="running || sending" @click="generate(item.prompt, item.model_id, item.has_checkpoint ? item.id : undefined)"><RotateCw :size="14" /> {{ item.has_checkpoint ? '继续修改候选' : '重试' }}</button>
              </div>
            </div>
          </div>
        </div>
        <div class="editor-area">
          <div v-if="activeModel?.source === 'platform' && !activeModel.available" class="model-note">
            <CircleAlert :size="15" /><span>平台 DeepSeek 尚未配置。<button class="link" @click="showModels">添加自己的 Key</button><template v-if="demoModel && current.kind === 'website'">，或<button class="link" @click="sample">试用待办演示</button>。</template></span>
          </div>
          <div v-else-if="activeModel?.source === 'demo'" class="model-note">
            <CircleAlert :size="15" /><span>离线样例只生成待办网站。<button class="link" @click="sample">{{ current.revision ? '填入修改示例' : '填入需求示例' }}</button></span>
          </div>
          <div v-else-if="research && !researchSearchAvailable" class="model-note">
            <CircleAlert :size="15" /><span>网页搜索尚未配置，可提供公开 HTTPS 链接或 API 地址。</span>
          </div>
          <p v-if="workspaceError || pollError" class="error" role="alert">{{ workspaceError || pollError }}</p>
          <p v-if="supportsAttachments && attachmentError" class="error notice" role="alert">{{ attachmentError }}</p>
          <p v-if="supportsAttachments && hasPendingAttachments" class="meta attachment-status-tip">
            <LoaderCircle class="spin" :size="14" /> 附件正在上传或经 MinerU 解析，完成后可发送…
          </p>
          <form class="composer" :class="{ dragging: supportsAttachments && attachmentDragging }"
            @submit.prevent="generate()"
            @dragenter="onComposerDragEnter" @dragover="onComposerDragOver"
            @dragleave="onComposerDragLeave" @drop="onComposerDrop">
            <input v-if="supportsAttachments" ref="attachmentPicker" type="file" :accept="attachmentAccept" multiple hidden @change="onAttachmentInput">
            <div v-if="supportsAttachments && attachmentDragging" class="composer-drop-hint">松开以上传文件到当前对话（单文件最大 10 MB）</div>
            <div v-if="supportsAttachments && attachments.length" class="composer-attachments" aria-label="当前对话附件">
              <div v-for="file in attachments" :key="file.id" class="attachment-chip" :class="'state-' + file.state"
                :title="file.error ? file.name + '：' + file.error : file.name + '（' + formatFileSize(file.size) + '）'">
                <button type="button" class="attachment-chip-main" :disabled="file.state !== 'ready'"
                  :aria-label="file.state === 'ready' ? '查看 ' + file.name + ' 解析正文' : file.name"
                  @click="openAttachmentPreview(file)">
                  <img v-if="file.thumbnail" :src="file.thumbnail" :alt="file.name" class="attachment-chip-thumb">
                  <LoaderCircle v-else-if="file.state === 'uploading' || file.state === 'parsing'" class="spin" :size="14" />
                  <CircleAlert v-else-if="file.state === 'failed'" :size="14" />
                  <FileText v-else :size="14" />
                  <span class="attachment-chip-name">{{ file.name }}</span>
                  <LoaderCircle v-if="file.thumbnail && (file.state === 'uploading' || file.state === 'parsing')" class="spin" :size="13" />
                  <span v-if="file.state !== 'ready'" class="attachment-chip-state">{{ attachmentStatusLabel[file.state] }}</span>
                </button>
                <button type="button" class="attachment-chip-remove" :aria-label="'移除 ' + file.name"
                  :disabled="removingAttachment === file.id" @click="removeAttachment(file)">
                  <X :size="13" />
                </button>
              </div>
            </div>
            <textarea v-model="prompt" @keydown.enter="sendOnEnter" @paste="onComposerPaste"
              :aria-label="knowledge ? '知识库问题' : research ? '调研主题' : ppt ? 'PPT 需求' : word ? 'Word 文档需求' : '建站需求'"
              :placeholder="knowledge ? '根据上传的资料提问…' : research ? '提问、继续讨论，或粘贴/上传文件生成调研报告…' : ppt ? '描述 PPT 主题、页数、风格，或粘贴/上传参考文件…' : word ? '描述 Word 文档主题、章节、受众，或粘贴/上传参考文件…' : current.revision ? '提问、粘贴/上传文件，或描述你想修改的地方…' : '提问、粘贴/上传参考文件，或描述你想生成的网站…'" rows="3" maxlength="6000"></textarea>
            <div class="composer-actions">
              <div class="model-choice">
                <select v-model="selectedModel" aria-label="调用模型">
                  <option v-for="model in workspaceModels" :key="model.id" :value="model.id">{{ modelLabel(model) }}</option>
                </select>
                <button class="icon" aria-label="打开模型设置" type="button" @click="showModels"><Settings2 :size="17" /></button>
                <button v-if="supportsAttachments" class="quiet attach-trigger" type="button"
                  :disabled="attachmentUploading || loadingChat"
                  :title="attachmentMineru ? '上传或直接粘贴文件（Excel/Word/PPT/PDF/图片/文本，单文件最大 10 MB）' : '上传或粘贴文本文件（配置 MINERU_API_KEY 后支持 Office/PDF/图片）'"
                  @click="attachmentPicker?.click()">
                  <LoaderCircle v-if="attachmentUploading" class="spin" :size="15" />
                  <Paperclip v-else :size="15" />
                  <span>{{ attachmentUploading ? '上传中…' : '上传文件' }}</span>
                </button>
              </div>
              <button v-if="activeGeneration && runningInAnotherChat" class="quiet" type="button" @click="selectChat(activeGeneration.chat_id ?? '')"><LoaderCircle class="spin" :size="14" /> 查看正在生成的对话</button>
              <button v-else-if="activeGeneration" class="stop-generation" type="button" :disabled="stopping || activeGeneration.agent_progress === '正在停止生成…'" @click="stopGeneration"><Square :size="14" /> {{ stopping || activeGeneration.agent_progress === '正在停止生成…' ? '正在停止…' : '停止生成' }}</button>
              <button v-else class="primary send" type="submit" :disabled="!prompt.trim() || !activeModel?.available || sending || loadingChat || hasPendingAttachments"><Send :size="15" /> 发送</button>
            </div>
          </form>
        </div>
      </aside>
      <div class="workspace-divider" role="separator" tabindex="0" aria-orientation="vertical"
        aria-label="调整对话和预览宽度" aria-controls="conversation-pane"
        :aria-valuemin="minimumConversationWidth" :aria-valuemax="maximumConversationWidth"
        :aria-valuenow="actualConversationWidth" @pointerdown="startDividerDrag" @pointermove="moveDivider"
        @pointerup="endDividerDrag" @pointercancel="endDividerDrag" @lostpointercapture="endDividerDrag"
        @keydown="resizeDividerByKey"></div>
      <ReportPane v-if="research" :project-id="current.id" :report-id="reportId" />
      <PptPane v-else-if="ppt" :project-id="current.id" :deck-id="reportId" />
      <WordPane v-else-if="word" :project-id="current.id" :doc-id="reportId" />
      <KnowledgePane v-else-if="knowledge" :key="current.id" :project-id="current.id" />
      <section v-else class="result">
        <header class="pane-head result-head">
          <div class="tabs" aria-label="结果视图">
            <button :aria-pressed="tab === 'preview'" @click="setTab('preview')"><Monitor :size="17" /> 预览</button>
            <button :aria-pressed="tab === 'source'" @click="setTab('source')"><Code2 :size="18" /> 源码</button>
          </div>
          <div v-if="tab === 'preview'" class="preview-actions">
            <span class="status" :class="current.draftRevision ? 'starting' : current.preview"><i></i>{{ starting ? '处理中' : current.revision || current.draftRevision || current.hasSavedDraft ? stateLabel(current) : '未生成' }}</span>
            <button v-if="current.revision" type="button" @click="manageShare('open')"><Link2 :size="16" /> 分享预览</button>
            <button v-if="current.hasSavedDraft && !current.draftRevision" type="button" :disabled="starting" @click="runPreview(true, true)"><Play :size="15" /> 预览候选</button>
            <template v-if="current.preview === 'running' || current.draftRevision">
              <button class="icon" type="button" title="刷新预览" aria-label="刷新预览" @click="loadPreview"><RotateCw :size="16" /></button>
              <button class="quiet" type="button" :disabled="starting" @click="runPreview(false)"><Square :size="14" /> 停止</button>
            </template>
            <button v-else-if="current.revision" type="button" :disabled="starting" @click="runPreview(true)"><Play :size="15" /> 启动预览</button>
          </div>
          <span v-else-if="source" class="source-label"><LockKeyhole :size="14" /> 只读 · 版本 {{ source.version }}</span>
        </header>
        <div v-if="tab === 'preview'" class="result-stage">
          <p v-if="previewError" class="error notice" role="alert">{{ previewError }}</p>
          <PreviewFrame v-if="preview" :key="previewReload" :request-path="'projects/' + current.id + '/preview/request'" :value="preview" @expired="refreshWorkspace" />
          <div v-else class="empty-preview">
            <span class="large-icon"><Monitor :size="27" /></span>
            <h2>{{ starting ? '正在准备预览' : current.revision ? '预览已停止' : current.hasSavedDraft ? '候选版本已保存' : running ? '正在生成首版' : '还没有预览' }}</h2>
            <p>{{ current.revision ? '启动后可以在这里试用网站。' : current.hasSavedDraft ? '可打开已保存的候选版本查看进度。' : running ? '首个候选版本启动后会显示在这里。' : '生成首版后可以在这里试用网站。' }}</p>
            <button v-if="current.revision && !starting" @click="runPreview(true)"><Play :size="16" /> 启动预览</button>
          </div>
        </div>
        <div v-else-if="source" class="source-stage">
          <nav aria-label="项目文件">
            <span class="source-nav-label">文件</span>
            <button v-for="file in fileNames" :key="file" :aria-pressed="sourceFile === file" @click="sourceFile = file"><FileCode2 :size="15" /> {{ file }}</button>
          </nav>
          <section class="source-editor" aria-label="源码查看器">
            <header class="source-file-heading"><FileCode2 :size="15" aria-hidden="true" /><span>{{ sourceFile }}</span></header>
            <div :key="sourceFile" class="source-scroll" tabindex="0" aria-label="只读源码">
              <span class="source-gutter" aria-hidden="true">{{ sourceLineNumbers }}</span>
              <pre><code>{{ sourceText }}</code></pre>
            </div>
          </section>
        </div>
        <div v-else class="empty-preview">
          <span class="large-icon"><Code2 :size="26" /></span><h2>{{ current.revision ? '正在读取源码' : '还没有源码' }}</h2>
        </div>
      </section>
    </main>
  </div>

  <div v-if="modal" class="modal-overlay" @click.self="closeModal" @keydown.esc="closeModal">
    <section class="dialog" :class="{ 'model-dialog': modal === 'models', 'attachment-dialog': modal === 'attachment' }" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
      <header class="dialog-heading">
        <h2 id="dialog-title">{{ { create: projectCategories.find(category => category.kind === newProjectKind)?.createLabel, rename: '重命名项目', delete: '删除项目', models: '模型设置', share: '分享预览', attachment: previewAttachment?.name || '附件解析内容' }[modal] }}</h2>
        <button class="icon" aria-label="关闭" @click="closeModal"><X :size="20" /></button>
      </header>
      <template v-if="modal === 'attachment' && previewAttachment">
        <img v-if="previewAttachment.thumbnail" :src="previewAttachment.thumbnail" :alt="previewAttachment.name" class="attachment-preview-image">
        <p class="meta">共 {{ previewAttachment.text.length }} 字符 · 点击关闭返回对话</p>
        <pre class="attachment-preview-text">{{ previewAttachment.text }}</pre>
      </template>
      <template v-else-if="modal === 'share'">
        <p class="description">知道链接的人可以打开并操作预览，无需登录。访客使用独立数据，链接创建后 24 小时失效。</p>
        <div v-if="shareLink" class="stack">
          <label>分享链接
            <span class="share-copy">
              <input ref="shareInput" :value="shareLink.url" readonly @focus="shareInput?.select()">
              <button type="button" @click="copyShare"><Copy :size="15" /> 复制</button>
            </span>
          </label>
          <p class="meta">版本 {{ shareLink.version }} · {{ formatDate(shareLink.expires) }} 到期<template v-if="!shareLink.current"> · 项目已有新版本</template></p>
        </div>
        <p v-if="modalError" class="error" role="alert">{{ modalError }}</p>
        <p v-if="shareFeedback" class="success" role="status">{{ shareFeedback }}</p>
        <div class="dialog-actions wrap">
          <button v-if="shareLink" class="quiet danger-text" :disabled="busy" @click="manageShare('revoke')">撤销链接</button>
          <button v-if="shareLink && !shareLink.current" class="primary" :disabled="busy" @click="manageShare('create')">分享新版并替换旧链接</button>
          <button v-if="!shareLink" class="primary" :disabled="busy" @click="manageShare('create')">{{ busy ? '请稍候…' : '创建分享链接' }}</button>
        </div>
      </template>
      <template v-else-if="modal === 'models'">
        <p class="description">平台默认使用 DeepSeek。你也可以添加兼容 OpenAI Chat Completions 的接口。</p>
        <div v-if="customModels.length" class="saved-models">
          <button v-for="model in customModels" :key="model.id" :aria-pressed="modelDraft.id === model.id" @click="editModel(model)">{{ model.name }}</button>
          <button class="quiet" @click="editModel()"><Plus :size="15" /> 添加</button>
        </div>
        <form class="stack" @submit.prevent="modelAction('save')">
          <label>配置名称<input v-model.trim="modelDraft.name" required maxlength="48" placeholder="例如：我的 DeepSeek"></label>
          <label>接口地址（Base URL）<input v-model.trim="modelDraft.baseUrl" type="url" required maxlength="500" placeholder="https://api.example.com/v1"></label>
          <label>模型名<input v-model.trim="modelDraft.model" required maxlength="160" placeholder="例如 deepseek-flash"></label>
          <label>API Key<input v-model.trim="modelDraft.key" type="password" autocomplete="new-password" :required="!modelDraft.id" maxlength="1024" :placeholder="modelDraft.id ? '留空保留现有 Key' : '输入 API Key'"></label>
          <p v-if="modalError" class="error" role="alert">{{ modalError }}</p>
          <p v-if="modelFeedback" class="success" role="status"><Check :size="16" /> {{ modelFeedback }}</p>
          <div class="dialog-actions wrap">
            <button v-if="modelDraft.id" type="button" class="quiet danger-text" :disabled="busy" @click="modelAction('delete')"><Trash2 :size="15" /> 删除配置</button>
            <button type="button" :disabled="busy" @click="modelAction('test')">测试连接</button>
            <button class="primary" :disabled="busy" type="submit">{{ busy ? '处理中…' : '保存并选用' }}</button>
          </div>
        </form>
      </template>
      <form v-else class="stack" @submit.prevent="saveProject">
        <p v-if="modal === 'delete'">确定删除「{{ target?.name }}」吗？{{ target?.kind === 'knowledge' ? '该知识库的对话和文件解析内容将一起删除。' : target?.kind === 'research' ? '该项目的对话和报告将一起删除。' : target?.kind === 'ppt' ? '该项目的对话和所有 PPT 版本将一起删除。' : target?.kind === 'word' ? '该项目的对话和所有 Word 文档版本将一起删除。' : '该项目的对话、源码和预览数据将一起删除。' }}</p>
        <label v-else>项目名称<input ref="nameInput" v-model.trim="name" required maxlength="60" :placeholder="newProjectKind === 'knowledge' ? '例如：公司制度' : newProjectKind === 'research' ? '例如：行业趋势调研' : newProjectKind === 'ppt' ? '例如：Q3 产品战略汇报' : newProjectKind === 'word' ? '例如：2026 年度数字化实施方案' : '例如：每日待办'"></label>
        <p v-if="modalError" class="error" role="alert">{{ modalError }}</p>
        <div class="dialog-actions">
          <button type="button" @click="closeModal">取消</button>
          <button v-if="modal === 'delete'" class="danger" :disabled="busy" type="submit">删除项目</button>
          <button v-else class="primary" :disabled="busy" type="submit">{{ modal === 'create' ? newProjectKind === 'knowledge' ? '创建知识库' : newProjectKind === 'research' ? '创建调研' : newProjectKind === 'ppt' ? '创建 PPT' : newProjectKind === 'word' ? '创建 Word' : '创建项目' : '保存' }}</button>
        </div>
      </form>
    </section>
  </div>
</template>
