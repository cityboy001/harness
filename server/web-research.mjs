import sanitizeHtml from 'sanitize-html';
import { PublicError } from './models.mjs';
import { fetchPublicPage, webUrl } from './research-network.mjs';

export const tool = (name, description, parameter) => ({
  type: 'function',
  function: { name, description, parameters: {
    type: 'object', properties: { [parameter]: { type: 'string' } },
    required: [parameter], additionalProperties: false
  } }
});
const searchTool = tool('search_web', '搜索公开网页，返回标题、网址、摘要。查询最多 128 个字符。', 'query');
const readTool = tool('read_web_page', '读取一个搜索结果的正文，用于核实细节。', 'url');

async function deepSeekWebRequest(operation, key, data, signal) {
  const response = await fetch('https://api.deepseek.com/v1/tools/' + operation, {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(data), redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(operation === 'search' ? 12000 : 20000)])
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new PublicError(502, 'DeepSeek ' + (operation === 'search' ? '搜索' : '网页读取') + '返回 HTTP ' + response.status + '。');
  }
  return response.json();
}

export function deepSeekWebTools(key) {
  return {
    async search(query, signal) {
      const data = await deepSeekWebRequest('search', key, { query, count: 6 }, signal);
      return (data.results ?? []).map(({ title, url, snippet }) => ({ title, url, description: snippet }));
    },
    async read(url, signal) {
      const data = await deepSeekWebRequest('fetch', key, { url }, signal);
      return { url, text: typeof data.content === 'string' ? data.content.slice(0, 12000) : '' };
    }
  };
}

async function readWebPage(value, signal) {
  const { url, status, contentType, body } = await fetchPublicPage(value, { signal });
  if (status !== 200 || !/^(?:text\/(?:html|plain)|application\/xhtml\+xml)(?:;|$)/i.test(contentType)) {
    throw new Error('此来源未返回可读网页。');
  }
  const text = /^text\/plain/i.test(contentType) ? body : sanitizeHtml(body, {
    allowedTags: [], allowedAttributes: {},
    nonTextTags: ['script', 'style', 'head', 'textarea', 'noscript', 'template', 'svg', 'nav', 'footer'],
    textFilter: (value) => ' ' + value
  });
  return { url, text: text.replace(/\s+/g, ' ').trim().slice(0, 12000) };
}

export function createWebResearchTools({ search, read = readWebPage, signal, onActivity, searchLimit = 8, pageLimit = 10 }) {
  const sources = new Set();
  const queries = new Set();
  const pages = new Set();
  let searchError;
  const handlers = new Map([
    ['search_web', async ({ query }) => {
      query = typeof query === 'string' ? query.trim() : '';
      if (!query || [...query].length > 128 || queries.has(query) || queries.size >= searchLimit) {
        return JSON.stringify({ error: '查询为空、重复或达到搜索上限。' });
      }
      queries.add(query);
      const update = onActivity?.('正在搜索公开网页', query);
      try {
        const result = (await search(query, signal)).slice(0, 6).flatMap((item) => {
          const url = webUrl(item.url);
          if (!url) return [];
          sources.add(url.href);
          return [{ url: url.href, title: String(item.title ?? '').slice(0, 300),
            description: String(item.description ?? '').slice(0, 800) }];
        });
        if (typeof update === 'function') update([query, ...(result.length ? result.map(({ title, url }) =>
          `${title || new URL(url).hostname}（${new URL(url).hostname}）`) : ['未找到结果。'])].join('\n'));
        return JSON.stringify(result);
      } catch (error) {
        signal.throwIfAborted();
        searchError = error instanceof PublicError ? error : new PublicError(502, '暂时无法访问网页搜索服务，请重试。');
        if (typeof update === 'function') update(`${query}\n${searchError.message}`);
        return JSON.stringify({ error: searchError.message });
      }
    }],
    ['read_web_page', async ({ url }) => {
      const address = webUrl(url)?.href;
      if (!sources.has(address) || pages.has(address) || pages.size >= pageLimit) {
        return JSON.stringify({ error: '请选择尚未读取的搜索结果。' });
      }
      pages.add(address);
      const update = onActivity?.('正在阅读 ' + new URL(address).hostname);
      try {
        const page = await read(address, signal);
        const resolved = webUrl(page.url);
        if (resolved) sources.add(resolved.href);
        if (page.text) {
          if (typeof update === 'function') update(`${resolved?.href ?? address}\n已读取网页正文。`);
          return JSON.stringify(page);
        }
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof PublicError) {
          if (typeof update === 'function') update(`${address}\n${error.message}`);
          return JSON.stringify({ error: error.message });
        }
      }
      if (typeof update === 'function') update(`${address}\n无法读取网页正文。`);
      return JSON.stringify({ error: '无法读取该网页，可查找其他来源。' });
    }]
  ]);
  return { sources, handlers, definitions: [searchTool, readTool],
    get calls() { return queries.size + pages.size; },
    get error() { return searchError; } };
}
