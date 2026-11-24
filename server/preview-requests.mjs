import { PublicError } from './models.mjs';

const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

export function previewInput(value) {
  const { method, path, query, body } = value ?? {};
  if (!methods.has(method) || typeof path !== 'string' || !/^\/api(?:\/[\w.-]{1,100}){1,12}\/?$/.test(path) ||
      path.split('/').some((part) => part === '.' || part === '..') ||
      (query && (typeof query !== 'object' || Array.isArray(query)))) {
    throw new PublicError(400, '预览只支持本项目的 JSON API。');
  }
  return { method, path, query: query ?? {}, body: body ?? null };
}
