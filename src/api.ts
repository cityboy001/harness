export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, method = 'GET', body?: unknown, anonymous = false): Promise<T> {
  const url = new URL('./api/' + path, location.href);
  const file = body instanceof Blob;
  const response = await fetch(url, {
    method,
    credentials: anonymous ? 'omit' : 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': file ? 'application/octet-stream' : 'application/json' },
    body: body === undefined ? undefined : file ? body : JSON.stringify(body)
  }).catch(() => { throw new ApiError(0, '暂时无法连接服务器，请检查网络后重试。'); });
  const value = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, value?.error || '网络请求失败，请稍后重试。');
  return value as T;
}

export function message(error: unknown) {
  return error instanceof Error ? error.message : '操作失败，请稍后重试。';
}

export interface User { id: string; name: string }
export type ProjectKind = 'website' | 'research' | 'ppt' | 'word' | 'knowledge';
export interface Project { id: string; name: string; kind: ProjectKind; updated: number; revision: string | null; draftRevision?: string | null; hasSavedDraft?: boolean; preview: 'starting' | 'running' | 'stopped' }
export interface Model { id: string; name: string; model: string; source: 'platform' | 'custom' | 'demo'; available: boolean; baseUrl?: string }
export type AgentRole = 'central' | 'frontend' | 'backend' | 'browser' | 'direct' | 'analyze' | 'read_project' | 'edit_project';
export type AgentState = 'waiting' | 'running' | 'done' | 'failed';
export type AcceptanceStatus = 'passed' | 'failed' | 'unverified' | 'not_run';
interface LayoutMeasurement { value: number; width: number; height: number; page: string }
export interface AcceptanceItem {
  id: string;
  requirement: string;
  expected: string;
  kind: 'primary' | 'regression';
  status: AcceptanceStatus;
  detail: string;
  checks: {
    number: number; action: string; selector?: string; scope?: string; reference?: string;
    value?: string; minCount?: number; maxCount?: number; metric?: string; status: AcceptanceStatus; detail: string;
    actual?: LayoutMeasurement; baseline?: LayoutMeasurement;
  }[];
}
export type AgentEvent =
  | { kind: 'assign'; role: AgentRole; task: string; round: number; taskId?: string; title?: string; dependsOn?: string[] }
  | { kind: 'status'; role: AgentRole; state: AgentState; detail?: string; taskId?: string; title?: string }
  | { kind: 'check'; role: 'browser'; state: 'done' | 'failed'; round: number; step?: number; action?: string; selector?: string; expected?: string; detail?: string; diagnostic?: boolean }
  | { kind: 'activity'; taskId?: string; detail: string; decision?: string; details?: string }
  | { kind: 'progress'; detail: string; details?: string; taskId?: never; decision?: never }
  | { kind: 'acceptance'; taskId?: string; candidateDigest: string; round: number; items: AcceptanceItem[] };
export interface Conversation { id: string; prompt: string; model_id: string; model_name: string; state: 'running' | 'failed' | 'complete' | 'stopped'; response: string | null; created: number; has_reasoning: 0 | 1; has_checkpoint?: 0 | 1; result_type: 'answer' | 'revision' | 'report' | 'ppt' | 'word' | null; agent_progress: string | null; agent_events?: AgentEvent[]; attachments?: ChatAttachment[] }
export interface ProjectChat { id: string; title: string }
export interface ProjectWorkspace {
  project: Project;
  chats: ProjectChat[];
  messages: Conversation[];
  researchSearchAvailable: boolean;
  activeGeneration: { id: string; chat_id: string | null; agent_progress: string | null } | null;
}
export interface ResearchReport { html: string; version: number }
export interface PptTheme {
  name: string;
  primary: string;
  secondary: string;
  surface: string;
  accent: string;
  text: string;
  muted: string;
  onPrimary: string;
  fontFamily: string;
}
export type PptTransition = 'none' | 'fade' | 'push' | 'wipe' | 'zoom';
export interface PptSlide {
  index: number;
  title: string;
  layout: string;
  tone: 'dark' | 'light';
  transition?: PptTransition;
  html: string;
  notes: string;
}
export interface PptDeck {
  templateId: string;
  title: string;
  theme: PptTheme;
  slides: PptSlide[];
}
export interface PptDeckRecord { deck: PptDeck; version: number }
export interface WordTheme {
  name: string;
  primary: string;
  accent: string;
  surface: string;
  text: string;
  muted: string;
  border: string;
  fontPreset?: 'sans' | 'serif' | 'fangsong' | 'kaiti';
  fontSize?: number;
  lineHeight?: number;
  paragraphSpacing?: number;
  pageMargin?: 'narrow' | 'normal' | 'wide';
  headingStyle?: 'underline' | 'bar' | 'plain' | 'center';
  firstLineIndent?: boolean;
  tableDensity?: 'compact' | 'normal' | 'relaxed';
  fontFamily: string;
  headingFontFamily?: string;
}
export interface WordMeta {
  author: string;
  organization: string;
  date: string;
  docNo: string;
  category: string;
}
export interface WordSection {
  index: number;
  title: string;
  html: string;
  pageBreakBefore: boolean;
}
export interface WordDoc {
  templateId: string;
  title: string;
  subtitle: string;
  headerText: string;
  showCover: boolean;
  showToc: boolean;
  showHeaderFooter?: boolean;
  meta: WordMeta;
  theme: WordTheme;
  sections: WordSection[];
}
export interface WordDocRecord { doc: WordDoc; version: number }
export interface ChatAttachment {
  id: string;
  name: string;
  size: number;
  created: number;
  state: 'uploading' | 'parsing' | 'ready' | 'failed';
  error: string | null;
  thumbnail?: string | null;
}
export interface Revision { revision: string; version: number; files: Record<string, string> }
export interface SharedRevision extends Revision { name: string }
export interface ShareLink { url: string; expires: number; version: number; current: boolean }
