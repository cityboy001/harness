import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

export class PublicError extends Error {
  constructor(status, message) {
    super(message);
    this.statusCode = status;
  }
}

export class ModelOutputLimitError extends PublicError {
  constructor() {
    super(502, '模型输出达到上限，请缩小这次改动范围。');
  }
}

const blockedNetworks = [
  '192.88.99.0/24', '198.18.0.0/15', '2001::/23', '2001:db8::/32', '2002::/16', '3fff::/20'
].map((range) => ipaddr.parseCIDR(range));
const globalIPv6 = ipaddr.parseCIDR('2000::/3');

export function isPublicAddress(value) {
  try {
    const address = ipaddr.process(value);
    if (address.range() !== 'unicast') return false;
    if (address.kind() === 'ipv6' && !address.match(globalIPv6)) return false;
    return !blockedNetworks.some((range) => range[0].kind() === address.kind() && address.match(range));
  } catch {
    return false;
  }
}

export function parseEndpoint(input) {
  let url;
  try {
    url = new URL(input);
    const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
    const internalName = !host.includes('.') || /(?:^|\.)(?:localhost|local|internal|test|invalid|onion)$/.test(host);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
        (isIP(host) ? !isPublicAddress(host) : internalName)) throw new Error();
  } catch {
    throw new PublicError(400, '请输入公开的 HTTPS 接口地址，例如 https://api.example.com/v1。');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

function assertModelStatus(status) {
  if ([401, 403].includes(status)) throw new PublicError(422, '模型服务拒绝了请求，请检查 API Key 和模型权限。');
  if ([402, 429].includes(status)) throw new PublicError(429, '模型服务额度不足或请求过多，请稍后重试。');
  if (status !== 200) throw new PublicError(502, '模型服务返回 HTTP ' + status + '，请检查接口和模型名。');
}

function decodeModelJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    throw new PublicError(502, '模型返回了无法识别的响应。');
  }
}

export async function readCompletionStream(response, onReasoning) {
  response.setEncoding?.('utf8');
  const message = { role: 'assistant', content: '', reasoning_content: '' };
  const calls = new Map();
  let finishReason;
  let usage;
  let bytes = 0;
  let buffer = '';
  let data = [];
  let done = false;

  function event() {
    if (data.length === 0) return;
    const payload = data.join('\n');
    data = [];
    if (payload === '[DONE]') {
      done = true;
      return;
    }
    const value = decodeModelJson(payload);
    if (value?.error) throw new PublicError(502, '模型服务中断了生成。');
    if (value?.usage) usage = value.usage;
    const choice = value?.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta;
    if (typeof delta?.content === 'string') message.content += delta.content;
    if (typeof delta?.reasoning_content === 'string') {
      message.reasoning_content += delta.reasoning_content;
      onReasoning?.(delta.reasoning_content);
    }
    if (message.content.length + message.reasoning_content.length > 320000) {
      throw new PublicError(502, '模型响应超过大小上限。');
    }
    for (const part of delta?.tool_calls ?? []) {
      const index = part.index;
      if (!Number.isInteger(index) || index < 0 || index >= 16) throw new PublicError(502, '模型返回了无效的工具调用。');
      const call = calls.get(index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (typeof part.id === 'string') call.id += part.id;
      if (typeof part.function?.name === 'string') call.function.name += part.function.name;
      if (typeof part.function?.arguments === 'string') call.function.arguments += part.function.arguments;
      const argumentLimit = call.function.name === 'test_preview' ? 120000 : 8192;
      if (call.id.length > 256 || call.function.name.length > 80 || call.function.arguments.length > argumentLimit) {
        throw new PublicError(502, '模型工具调用超过大小上限。');
      }
      calls.set(index, call);
    }
  }

  for await (const chunk of response) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 16 * 1024 * 1024) throw new PublicError(502, '模型响应超过大小上限。');
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end).replace(/\r$/, '');
      buffer = buffer.slice(end + 1);
      if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      else if (line === '') event();
    }
    if (buffer.length > 512000 || data.length > 64) throw new PublicError(502, '模型流式响应格式无效。');
    if (done) break;
  }
  if (!finishReason) throw new PublicError(502, '模型响应中断，请重试。');
  if (calls.size) message.tool_calls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
  return { message, finishReason, usage };
}

async function readModelResponse(response, onReasoning) {
  assertModelStatus(response.statusCode);
  if (String(response.headers['content-type']).includes('text/event-stream')) {
    return readCompletionStream(response, onReasoning);
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of response) {
    length += chunk.length;
    if (length > 1048576) throw new PublicError(502, '模型响应超过大小上限。');
    chunks.push(chunk);
  }
  const value = decodeModelJson(Buffer.concat(chunks).toString('utf8'));
  const choice = value?.choices?.[0];
  if (typeof choice?.message?.reasoning_content === 'string' && choice.message.reasoning_content) {
    onReasoning?.(choice.message.reasoning_content);
  }
  return { message: choice?.message, finishReason: choice?.finish_reason, usage: value?.usage };
}

export function isDeepSeek(config) {
  return config.platform || (config.baseUrl && new URL(config.baseUrl).hostname.toLowerCase().replace(/\.$/, '') === 'api.deepseek.com');
}

export async function chatCompletion(config, messages, maxTokens, options = {}) {
  const endpoint = parseEndpoint(config.baseUrl);
  if (!endpoint.pathname.endsWith('/chat/completions')) {
    endpoint.pathname = endpoint.pathname.replace(/\/$/, '') + '/chat/completions';
  }
  const host = endpoint.hostname.replace(/^\[|\]$/g, '');
  let addresses;
  const timeout = AbortSignal.timeout(options.test ? 15000 : 120000);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  try {
    signal.throwIfAborted();
    addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      lookup(host, { all: true }).then(resolve, reject);
    });
  } catch {
    throw new PublicError(502, signal.aborted ? '模型请求超时，请重试。' : '无法解析模型服务地址。');
  }
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new PublicError(400, '模型接口必须解析到公开 IP 地址。');
  }
  const pinned = addresses.find(({ family }) => family === 4) ?? addresses[0];
  const payload = JSON.stringify({
    model: config.model,
    messages,
    max_tokens: maxTokens,
    ...(isDeepSeek(config) ? {
      thinking: { type: options.thinking ? 'enabled' : 'disabled' },
      ...(options.thinking ? { reasoning_effort: 'low' } : {})
    } : {}),
    ...(options.tools ? { tools: options.tools } : {}),
    ...(options.toolChoice ? { tool_choice: options.toolChoice } : {}),
    ...(options.stream ? { stream: true, stream_options: { include_usage: true } } : {})
  });
  const result = await new Promise((resolve, reject) => {
    const call = request(endpoint, {
      method: 'POST',
      agent: false,
      signal,
      lookup(_hostname, options, callback) {
        if (options.all) callback(null, [pinned]);
        else callback(null, pinned.address, pinned.family);
      },
      headers: {
        authorization: 'Bearer ' + config.key,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      }
    }, (response) => {
      readModelResponse(response, options.onReasoning).then(resolve, (error) => {
        reject(error);
        response.destroy();
      });
    });
    call.on('error', (error) => reject(new PublicError(502, error.name === 'AbortError' ? '模型请求超时，请重试。' : '模型服务不可达，请检查地址或网络。')));
    call.end(payload);
  }).catch((error) => {
    if (error instanceof PublicError) throw error;
    throw new PublicError(502, signal.aborted ? '模型请求超时，请重试。' : '模型响应中断，请重试。');
  });
  if (result.finishReason === 'length' && !options.test) throw new ModelOutputLimitError();
  if (result.finishReason === 'content_filter') throw new PublicError(422, '模型服务未完成这次请求，请检查需求后重试。');
  if (typeof result.message?.content !== 'string' && !result.message?.tool_calls?.length) {
    throw new PublicError(502, '模型没有返回文本内容。');
  }
  return result;
}
