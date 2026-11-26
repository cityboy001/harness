import { Worker } from 'node:worker_threads';
import { fetchPublicPage, webUrl } from './research-network.mjs';

const maxRequests = 8;
const maxResponseBytes = 512 * 1024;
const maxOutput = 16000;
const timeoutMs = 20000;

export async function runResearchCode(source, signal, fetchPage = fetchPublicPage, onFetch) {
  if (typeof source !== 'string' || !source.trim() || Buffer.byteLength(source) > 32000) {
    throw new Error('代码必须在 32 KB 以内。');
  }
  signal.throwIfAborted();
  const network = new AbortController();
  const deadline = Date.now() + timeoutMs;
  const worker = new Worker(new URL('./research-code-worker.mjs', import.meta.url), {
    workerData: { source, deadline, maxRequests, maxOutput },
    env: {}, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 64 }
  });
  const sources = new Set();
  let requests = 0;
  let abort;
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => resolve({ exitCode: 1, output: '', truncated: false, error: '代码执行超时。', sources: [...sources] }), timeoutMs);
      worker.once('error', reject);
      worker.once('exit', () => reject(new Error('代码沙盒提前退出。')));
      worker.on('message', async (message) => {
        if (message.type === 'result') return resolve({ ...message.result, sources: [...sources] });
        if (message.type !== 'fetch') return;
        const { id, url, method } = message;
        let response;
        try {
          if (++requests > maxRequests) throw new Error('本次运行的网络请求次数已用完。');
          const requested = webUrl(url);
          if (requested) onFetch?.(requested);
          response = await fetchPage(url, { method, maxBytes: maxResponseBytes, signal: network.signal });
          if (method === 'GET' && response.status >= 200 && response.status < 300) {
            const received = webUrl(response.url);
            if (requested) sources.add(requested.href);
            if (received) sources.add(received.href);
          }
        } catch (error) {
          response = { error: error.code || error.name === 'TimeoutError'
            ? '无法访问该公开网址或请求已超时。'
            : error.message };
        }
        if (!network.signal.aborted) worker.postMessage({ id, response });
      });
    });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    network.abort();
    await worker.terminate();
  }
}
