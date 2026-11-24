export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, method = 'GET', body?: unknown, anonymous = false): Promise<T> {
  const url = new URL('./api/' + path, location.href);
  const response = await fetch(url, {
    method,
    credentials: anonymous ? 'omit' : 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const value = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, value?.error || '网络请求失败，请稍后重试。');
  return value as T;
}

export function message(error: unknown) {
  return error instanceof Error ? error.message : '操作失败，请稍后重试。';
}

export interface User { id: string; name: string }
export interface Project { id: string; name: string; updated: number; revision: string | null; draftRevision?: string | null; preview: 'starting' | 'running' | 'stopped' }
export interface Model { id: string; name: string; model: string; source: 'platform' | 'custom' | 'demo'; available: boolean; baseUrl?: string }
export type AgentRole = 'central' | 'frontend' | 'backend' | 'browser' | 'direct' | 'analyze' | 'read_project';
export type AgentState = 'waiting' | 'running' | 'done' | 'failed';
export type AgentEvent =
  | { kind: 'assign'; role: AgentRole; task: string; round: number; taskId?: string; title?: string; dependsOn?: string[] }
  | { kind: 'status'; role: AgentRole; state: AgentState; detail?: string; taskId?: string; title?: string }
  | { kind: 'check'; role: 'browser'; state: 'done' | 'failed'; round: number; step?: number; action?: string; selector?: string; expected?: string; detail?: string };
export interface Conversation { id: string; prompt: string; model_id: string; model_name: string; state: 'running' | 'failed' | 'complete' | 'stopped'; response: string | null; created: number; has_reasoning: 0 | 1; result_type: 'answer' | 'revision' | null; agent_progress: string | null; agent_events?: AgentEvent[] }
export interface Revision { revision: string; version: number; files: Record<string, string> }
export interface SharedRevision extends Revision { name: string }
export interface ShareLink { url: string; expires: number; version: number; current: boolean }
