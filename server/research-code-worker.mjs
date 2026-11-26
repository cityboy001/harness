import { parentPort, workerData } from 'node:worker_threads';
import { getQuickJS } from 'quickjs-emscripten';

const { source, deadline, maxRequests, maxOutput } = workerData;
const engine = await getQuickJS();
const runtime = engine.newRuntime();
runtime.setMemoryLimit(24 * 1024 * 1024);
runtime.setMaxStackSize(256 * 1024);
runtime.setInterruptHandler(() => Date.now() >= deadline);
const vm = runtime.newContext();
const pending = new Map();
const output = [];
let outputBytes = 0;
let truncated = false;
let nextRequest = 0;

function expose(name, callback) {
  vm.newFunction(name, callback).consume((handle) => vm.setProp(vm.global, name, handle));
}

expose('__log', (handle) => {
  if (truncated) return;
  const value = Buffer.from(vm.getString(handle) + '\n');
  const remaining = maxOutput - outputBytes;
  output.push(value.subarray(0, remaining));
  outputBytes += Math.min(value.length, remaining);
  truncated = value.length > remaining;
});

expose('__fetch', (url, method) => {
  if (nextRequest >= maxRequests) return vm.newString('本次运行的网络请求次数已用完。');
  const address = vm.getString(url);
  const verb = vm.getString(method);
  if (address.length > 4096) return vm.newString('网址过长。');
  if (verb !== 'GET' && verb !== 'HEAD') return vm.newString('仅支持 GET 和 HEAD 请求。');
  const id = ++nextRequest;
  const promise = vm.newPromise();
  pending.set(id, promise);
  parentPort.postMessage({ type: 'fetch', id, url: address, method: verb });
  return promise.handle;
});

const bootstrap = vm.evalCode(`
  {
    const logger = globalThis.__log;
    const request = globalThis.__fetch;
    const stringify = JSON.stringify.bind(JSON);
    const parse = JSON.parse.bind(JSON);
    const toString = String;
    delete globalThis.__log;
    delete globalThis.__fetch;
    const log = (...values) => logger(values.map(value => {
      try { return typeof value === 'string' ? value : stringify(value) ?? toString(value); }
      catch { return '[无法序列化]'; }
    }).join(' ').slice(0, ${maxOutput}));
    globalThis.console = Object.freeze({ log, info: log, warn: log, error: log });
    globalThis.fetch = async (url, options = {}) => {
      if (typeof url !== 'string') throw new TypeError('fetch 需要网址字符串。');
      const method = toString(options.method ?? 'GET').toUpperCase();
      if (options.body !== undefined || options.headers !== undefined) {
        throw new TypeError('沙盒 fetch 仅支持无自定义请求头和请求体的请求。');
      }
      const response = request(url, method);
      if (typeof response === 'string') throw new Error(response);
      const { body, error, contentType, ...metadata } = parse(await response);
      if (error) throw new Error(error);
      return {
        ...metadata, ok: metadata.status >= 200 && metadata.status < 300,
        headers: { get: name => toString(name).toLowerCase() === 'content-type' ? contentType || null : null },
        text: async () => body, json: async () => parse(body)
      };
    };
  }
`);

function finish(error) {
  parentPort.postMessage({
    type: 'result',
    result: { exitCode: error ? 1 : 0, output: Buffer.concat(output).toString().trimEnd(), truncated, ...(error && { error }) }
  });
  parentPort.close();
}

if (bootstrap.error) {
  finish('无法初始化代码沙盒。');
} else {
  bootstrap.value.dispose();
  const code = vm.evalCode('(async () => {\n' + source + '\n})()', 'research.js');
  if (code.error) {
    finish(Date.now() >= deadline ? '代码执行超时。' : '代码执行失败，请检查 JavaScript 语法。');
  } else {
    const run = code.value;
    function step() {
      const jobs = runtime.executePendingJobs();
      if (jobs.error || Date.now() >= deadline) {
        finish('代码执行超时或达到资源上限。');
        return;
      }
      const state = vm.getPromiseState(run);
      if (state.type === 'pending') return;
      if (state.type === 'rejected') {
        const message = vm.getProp(state.error, 'message');
        const detail = vm.typeof(message) === 'string' ? vm.getString(message).slice(0, 500) : '';
        finish(detail || '代码抛出异常。');
      } else {
        finish();
      }
    }
    parentPort.on('message', ({ id, response }) => {
      const promise = pending.get(id);
      if (!promise) return;
      pending.delete(id);
      vm.newString(JSON.stringify(response)).consume((handle) => promise.resolve(handle));
      step();
    });
    step();
  }
}
