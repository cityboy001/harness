<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import {
  ArrowLeft, Blocks, Check, ChevronDown, CircleAlert, Code2, Ellipsis, FileCode2, FolderOpen, 
  Copy, Globe2, Link2, LoaderCircle, LockKeyhole, LogOut, Monitor, Pencil, Play, Plus, RotateCw, Send, Settings2,
  Sparkles, Square, Trash2, X
} from 'lucide-vue-next';
import { ApiError, api, message, type Conversation, type Model, type Project, type ProjectChat, type ProjectWorkspace, type Revision, type SharedRevision, type ShareLink, type User } from './api';
import PreviewFrame from './PreviewFrame.vue';
import AgentProgress from './AgentProgress.vue';

const user = ref<User | null>(null);
const initialized = ref(false);
const authMode = ref<'login' | 'register'>('register');
const username = ref('');
const password = ref('');
const projects = ref<Project[]>([]);
const current = ref<Project | null>(null);
const chats = ref<ProjectChat[]>([]);
const selectedChat = ref('');
const creatingChat = ref(false);
const loadingChat = ref(false);
const activeGeneration = ref<ProjectWorkspace['activeGeneration']>(null);
const chatDrafts = new Map<string, string>();
const history = ref<Conversation[]>([]);
const reasoning = ref<Record<string, string>>({});
const reasoningErrors = ref<Record<string, string>>({});
const expandedReasoning = new Set<string>();
const readingReasoning = new Set<string>();
const completedReasoning = new Set<string>();
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
const modal = ref<'create' | 'rename' | 'delete' | 'models' | 'share' | null>(null);
const modalError = ref('');
const modelFeedback = ref('');
const target = ref<Project | null>(null);
const modelDraft = ref({ id: '', name: '', baseUrl: '', model: '', key: '' });
const thread = ref<HTMLElement | null>(null);
const nameInput = ref<HTMLInputElement | null>(null);
const shareInput = ref<HTMLInputElement | null>(null);
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
const activeModel = computed(() => models.value.find((model) => model.id === selectedModel.value) ?? platform.value);
const fileNames = computed(() => Object.keys(source.value?.files ?? {}).sort());
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
function setUrl(id?: string, replace = false, chat = '') {
  const url = new URL(location.href);
  if (id) url.searchParams.set('project', id);
  else url.searchParams.delete('project');
  if (id && chat) url.searchParams.set('chat', chat);
  else url.searchParams.delete('chat');
  if (url.href !== location.href) window.history[replace ? 'replaceState' : 'pushState'](null, '', url);
}
function resetWorkspace() {
  viewToken++;
  renderToken++;
  current.value = null;
  selectedChat.value = '';
  chats.value = [];
  activeGeneration.value = null;
  creatingChat.value = false;
  loadingChat.value = false;
  chatDrafts.clear();
  history.value = [];
  reasoning.value = {};
  reasoningErrors.value = {};
  expandedReasoning.clear();
  completedReasoning.clear();
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
async function readReasoning(id: string) {
  const project = current.value?.id;
  const token = viewToken;
  if (!project || readingReasoning.has(id)) return;
  readingReasoning.add(id);
  try {
    const result = await api<{ reasoning: string | null; state: Conversation['state'] }>('projects/' + project + '/messages/' + id + '/reasoning');
    if (token === viewToken) {
      reasoning.value[id] = result.reasoning ?? '';
      if (result.state !== 'running') completedReasoning.add(id);
      delete reasoningErrors.value[id];
    }
  } catch (error) {
    if (token === viewToken) reasoningErrors.value[id] = message(error);
  } finally {
    readingReasoning.delete(id);
  }
}
function toggleReasoning(open: boolean, item: Conversation) {
  if (!open || item.agent_events?.some(event => event.kind === 'activity')) {
    expandedReasoning.delete(item.id);
    return;
  }
  expandedReasoning.add(item.id);
  if (!completedReasoning.has(item.id)) void readReasoning(item.id);
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
  if (id && current.value?.id === id) {
    if (chat && !chats.value.some((item) => item.id === chat)) setUrl(id, true, selectedChat.value);
    else await selectChat(chat, false);
  } else if (id) await openProject(id, false, chat);
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
  chats.value = result.chats;
  activeGeneration.value = result.activeGeneration;
  history.value = result.messages;
}
async function openProject(id: string, updateUrl = true, chat = '') {
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
    setUrl(id, !updateUrl, chat);
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
  prompt.value = chatDrafts.get(chat) ?? '';
  history.value = [];
  expandedReasoning.clear();
  workspaceError.value = '';
  loadingChat.value = true;
  if (updateUrl) setUrl(id, false, chat);
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
    updateWorkspace(result);
    for (const id of expandedReasoning) if (!completedReasoning.has(id)) void readReasoning(id);
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
async function generate(value = prompt.value, retryModel?: string, resumeMessageId?: string) {
  if (!current.value || running.value || sending.value || loadingChat.value || !value.trim()) return;
  const token = viewToken;
  const chatId = selectedChat.value;
  sending.value = true;
  workspaceError.value = '';
  const modelId = retryModel && models.value.some((model) => model.id === retryModel && model.available) ? retryModel : selectedModel.value;
  try {
    await api('projects/' + current.value.id + '/generate', 'POST', { prompt: value.trim(), modelId, chatId: chatId || null, resumeMessageId });
    if (token !== viewToken) return;
    if (resumeMessageId) completedReasoning.delete(resumeMessageId);
    if (!retryModel) {
      chatDrafts.delete(chatId);
      if (chatId === selectedChat.value) prompt.value = '';
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

function projectModal(kind: 'create' | 'rename' | 'delete', item?: Project) {
  modalError.value = '';
  modal.value = kind;
  target.value = item ?? null;
  name.value = item?.name ?? '';
  if (kind !== 'delete') void nextTick(() => nameInput.value?.focus());
}
function closeModal() {
  if (busy.value) return;
  modal.value = null;
  modelDraft.value.key = '';
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
      const result = await api<Project>('projects', 'POST', { name: name.value });
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
  poll = setInterval(() => void refreshWorkspace(), 1800);
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
      <div class="page-heading">
        <div><h1>我的项目</h1><p>打开已有网站，或从一句需求开始。</p></div>
        <button class="primary" @click="projectModal('create')"><Plus :size="17" /> 新建项目</button>
      </div>
      <p v-if="pageError" class="error notice" role="alert">{{ pageError }}</p>
      <div v-if="projects.length" class="project-list">
        <article v-for="item in projects" :key="item.id" class="project-row">
          <span class="project-icon"><Globe2 :size="20" /></span>
          <button class="project-entry" @click="openProject(item.id)"><strong>{{ item.name }}</strong><span>{{ formatDate(item.updated) }} 更新</span></button>
          <span class="status" :class="item.preview"><i></i>{{ stateLabel(item) }}</span>
          <details class="menu row-menu">
            <summary class="icon" :aria-label="item.name + ' 项目操作'"><Ellipsis :size="19" /></summary>
            <div class="menu-items">
              <button @click="projectModal('rename', item); ($event.currentTarget as HTMLElement).closest('details')?.removeAttribute('open')"><Pencil :size="15" /> 重命名</button>
              <button class="danger-text" @click="projectModal('delete', item); ($event.currentTarget as HTMLElement).closest('details')?.removeAttribute('open')"><Trash2 :size="15" /> 删除项目</button>
            </div>
          </details>
        </article>
      </div>
      <div v-else class="empty-projects">
        <span class="large-icon"><FolderOpen :size="25" /></span>
        <h2>还没有项目</h2><p>创建项目后，就可以描述你想做的网站。</p>
        <button @click="projectModal('create')"><Plus :size="17" /> 新建项目</button>
      </div>
    </main>

    <main v-else class="workspace">
      <aside class="conversation">
        <header class="pane-head chat-head">
          <strong>建站对话</strong>
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
            <h2>{{ current.revision ? '这次想做什么？' : '你想做什么网站？' }}</h2>
            <p>{{ current.revision ? '可以提问，也可以继续修改当前网站。' : '说说要实现的功能，生成后可以继续在这里修改。' }}</p>
          </div>
          <div v-for="item in history" :key="item.id" class="message-pair">
            <div class="user-message">{{ item.prompt }}</div>
            <div class="ai-message">
              <span class="ai-icon"><Sparkles :size="15" /></span>
              <div>
                <span class="meta">{{ item.model_name }} · {{ item.state === 'running' ? '处理中' : item.state === 'failed' ? '处理失败' : item.state === 'stopped' ? '已停止' : item.result_type === 'answer' ? '已回复' : '已生成' }}</span>
                <div v-if="item.state === 'failed'" class="generation-error">
                  <p class="danger-text" role="alert"><CircleAlert :size="16" aria-hidden="true" /><span>{{ item.response }}</span></p>
                  <button class="quiet retry" :disabled="running || sending" @click="generate(item.prompt, item.model_id, item.has_checkpoint ? item.id : undefined)"><RotateCw :size="14" /> {{ item.has_checkpoint ? '继续修改候选' : '重试' }}</button>
                </div>
                <AgentProgress v-if="item.agent_events?.length || item.has_reasoning"
                  :events="item.agent_events ?? []" :state="item.state"
                  :has-reasoning="Boolean(item.has_reasoning)" :reasoning="reasoning[item.id]"
                  :reasoning-error="reasoningErrors[item.id]" @toggle-progress="toggleReasoning($event, item)" />
                <p v-if="item.state === 'running'" class="in-progress"><LoaderCircle class="spin" :size="16" /> {{ item.agent_progress || '正在处理你的请求…' }}</p>
                <p v-else-if="item.state !== 'failed'">{{ item.response }}</p>
                <button v-if="item.state === 'stopped'" class="quiet retry" :disabled="running || sending" @click="generate(item.prompt, item.model_id, item.has_checkpoint ? item.id : undefined)"><RotateCw :size="14" /> {{ item.has_checkpoint ? '继续修改候选' : '重试' }}</button>
              </div>
            </div>
          </div>
        </div>
        <div class="editor-area">
          <div v-if="activeModel?.source === 'platform' && !activeModel.available" class="model-note">
            <CircleAlert :size="15" /><span>平台 DeepSeek 尚未配置。<button class="link" @click="showModels">添加自己的 Key</button><template v-if="demoModel">，或<button class="link" @click="sample">试用待办演示</button>。</template></span>
          </div>
          <div v-else-if="activeModel?.source === 'demo'" class="model-note">
            <CircleAlert :size="15" /><span>离线样例只生成待办网站。<button class="link" @click="sample">{{ current.revision ? '填入修改示例' : '填入需求示例' }}</button></span>
          </div>
          <p v-if="workspaceError || pollError" class="error" role="alert">{{ workspaceError || pollError }}</p>
          <form class="composer" @submit.prevent="generate()">
            <textarea v-model="prompt" aria-label="建站需求" :placeholder="current.revision ? '提问，或描述你想修改的地方…' : '提问，或描述你想生成的网站…'" rows="3" maxlength="6000"></textarea>
            <div class="composer-actions">
              <div class="model-choice">
                <select v-model="selectedModel" aria-label="调用模型">
                  <option v-for="model in models" :key="model.id" :value="model.id">{{ modelLabel(model) }}</option>
                </select>
                <button class="icon" aria-label="打开模型设置" type="button" @click="showModels"><Settings2 :size="17" /></button>
              </div>
              <button v-if="activeGeneration && runningInAnotherChat" class="quiet" type="button" @click="selectChat(activeGeneration.chat_id ?? '')"><LoaderCircle class="spin" :size="14" /> 查看正在生成的对话</button>
              <button v-else-if="activeGeneration" class="stop-generation" type="button" :disabled="stopping || activeGeneration.agent_progress === '正在停止生成…'" @click="stopGeneration"><Square :size="14" /> {{ stopping || activeGeneration.agent_progress === '正在停止生成…' ? '正在停止…' : '停止生成' }}</button>
              <button v-else class="primary send" type="submit" :disabled="!prompt.trim() || !activeModel?.available || sending || loadingChat"><Send :size="15" /> 发送</button>
            </div>
          </form>
        </div>
      </aside>
      <section class="result">
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
            <button v-for="file in fileNames" :key="file" :aria-pressed="sourceFile === file" @click="sourceFile = file"><FileCode2 :size="15" /> {{ file }}</button>
          </nav>
          <pre aria-label="只读源码"><code>{{ source.files[sourceFile] }}</code></pre>
        </div>
        <div v-else class="empty-preview">
          <span class="large-icon"><Code2 :size="26" /></span><h2>{{ current.revision ? '正在读取源码' : '还没有源码' }}</h2>
        </div>
      </section>
    </main>
  </div>

  <div v-if="modal" class="modal-overlay" @click.self="closeModal" @keydown.esc="closeModal">
    <section class="dialog" :class="{ 'model-dialog': modal === 'models' }" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
      <header class="dialog-heading">
        <h2 id="dialog-title">{{ { create: '新建项目', rename: '重命名项目', delete: '删除项目', models: '模型设置', share: '分享预览' }[modal] }}</h2>
        <button class="icon" aria-label="关闭" @click="closeModal"><X :size="20" /></button>
      </header>
      <template v-if="modal === 'share'">
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
        <p v-if="modal === 'delete'">确定删除「{{ target?.name }}」吗？该项目的对话、源码和预览数据将一起删除。</p>
        <label v-else>项目名称<input ref="nameInput" v-model.trim="name" required maxlength="60" placeholder="例如：每日待办"></label>
        <p v-if="modalError" class="error" role="alert">{{ modalError }}</p>
        <div class="dialog-actions">
          <button type="button" @click="closeModal">取消</button>
          <button v-if="modal === 'delete'" class="danger" :disabled="busy" type="submit">删除项目</button>
          <button v-else class="primary" :disabled="busy" type="submit">{{ modal === 'create' ? '创建项目' : '保存' }}</button>
        </div>
      </form>
    </section>
  </div>
</template>
