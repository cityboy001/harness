import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { isPublicAddress } from './models.mjs';

export function webUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) return;
  try {
    const url = new URL(value);
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url;
  } catch { /* Invalid URLs are handled by the caller. */ }
}

async function requestPage(url, { method, maxBytes, signal }) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || url.port || (!host.includes('.') && !isIP(host))) {
    throw new Error('仅支持公开 HTTPS 地址（默认端口）。');
  }
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    lookup(host, { all: true }).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
  signal.throwIfAborted();
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error('仅支持解析到公网 IP 的地址。');
  }
  const pinned = addresses.find(({ family }) => family === 4) ?? addresses[0];
  return new Promise((resolve, reject) => {
    const call = request(url, {
      method, signal, agent: false,
      headers: { 'Accept-Encoding': 'identity', 'User-Agent': 'ResearchWorkbench/1.0' },
      // Connect to the validated IP while retaining the original hostname for HTTP and TLS.
      lookup(_host, options, callback) {
        if (options.all) callback(null, [pinned]);
        else callback(null, pinned.address, pinned.family);
      }
    }, async (response) => {
      try {
        const status = response.statusCode;
        if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
          return resolve({ redirect: response.headers.location });
        }
        const contentType = response.headers['content-type'] ?? '';
        let size = 0;
        let truncated = false;
        const chunks = [];
        for await (const chunk of response) {
          const remaining = maxBytes - size;
          if (chunk.length > remaining) {
            chunks.push(chunk.subarray(0, remaining));
            truncated = true;
            break;
          }
          size += chunk.length;
          chunks.push(chunk);
        }
        const encoding = contentType.match(/charset\s*=\s*"?([\w-]+)/i)?.[1] ?? 'utf-8';
        let decoder;
        try { decoder = new TextDecoder(encoding); } catch { decoder = new TextDecoder(); }
        resolve({ url: url.href, status, contentType, body: decoder.decode(Buffer.concat(chunks)), truncated });
      } catch (error) {
        reject(error);
      } finally {
        response.destroy();
      }
    });
    call.on('error', reject);
    call.end();
  });
}

export async function fetchPublicPage(value, { method = 'GET', maxBytes = 1500000, signal: jobSignal }) {
  if (!['GET', 'HEAD'].includes(method)) throw new Error('仅支持 GET 和 HEAD 请求。');
  const signal = AbortSignal.any([jobSignal, AbortSignal.timeout(10000)]);
  let url = webUrl(value);
  for (let hop = 0; url && hop < 4; hop++) {
    signal.throwIfAborted();
    url.hash = '';
    const page = await requestPage(url, { method, maxBytes, signal });
    if (!page.redirect) return page;
    url = webUrl(new URL(page.redirect, url).href);
  }
  throw new Error('网页地址无效或重定向次数过多。');
}
