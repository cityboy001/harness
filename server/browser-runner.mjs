import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { text } from 'node:stream/consumers';
import { chromium } from 'playwright-core';
import { createPreviewDocument, previewSandbox, previewStorageUpdate } from '../src/preview-document.js';
import { Guest } from './preview.mjs';
import { previewInput } from './preview-requests.mjs';

const fixtureUrl = 'https://builder-preview.test/';
const actionTimeout = 2200;
const maxBody = 80000;
const maxApiEntries = 12;

// This function is installed in the trusted parent page, never in the generated document.
function mountFixture({ files, sandbox, srcdoc }) {
  let currentPage = 'index.html';
  let currentSearch = '';
  const storage = Object.create(null);
  let activePort;
  window.builderPending = 0;
  function mount() {
    activePort?.close();
    const frame = document.createElement('iframe');
    frame.id = 'preview';
    frame.setAttribute('sandbox', sandbox);
    frame.referrerPolicy = 'no-referrer';
    frame.addEventListener('load', () => {
      const { port1, port2 } = new MessageChannel();
      activePort = port1;
      port1.onmessage = async ({ data }) => {
        if (!data || typeof data !== 'object') return;
        if (data.type === 'storage') {
          window.builderUpdatePreviewStorage(storage, data);
          return;
        }
        if (data.type === 'navigate') {
          if (typeof data.page === 'string' && data.page.endsWith('.html') && Object.hasOwn(files, data.page) &&
              typeof data.search === 'string' && data.search.length <= 2048 && /^(?:\?[^#\r\n]*)?$/.test(data.search) &&
              (data.page !== currentPage || data.search !== currentSearch)) {
            currentPage = data.page;
            currentSearch = data.search;
            mount();
          }
          return;
        }
        if (data.type !== 'request' || !Number.isSafeInteger(data.id)) return;
        if (window.builderPending >= 8) {
          port1.postMessage({ id: data.id, status: 429, body: { error: 'Too many preview calls' } });
          return;
        }
        window.builderPending++;
        try {
          const result = await window.builderFixtureRequest(data);
          port1.postMessage({ id: data.id, ...result });
        } finally {
          window.builderPending--;
        }
      };
      frame.contentWindow.postMessage({ type: 'builder-preview', page: currentPage, search: currentSearch, storage, files }, '*', [port2]);
    }, { once: true });
    frame.srcdoc = srcdoc;
    document.body.replaceChildren(frame);
  }
  mount();
}

async function snapshot(target) {
  return (await target.ariaSnapshot({ timeout: actionTimeout })).slice(0, 4500);
}

async function visibleControls(scope) {
  return scope.locator('button, input, select, textarea, a, [role="button"]').evaluateAll((nodes) =>
    nodes.filter((node) => node.getClientRects().length).slice(0, 20).map((node) => ({
      tag: node.tagName.toLowerCase(),
      id: node.id.slice(0, 100),
      class: node.getAttribute('class')?.slice(0, 100),
      name: node.getAttribute('name')?.slice(0, 100),
      href: (node.getAttribute('data-preview-href') || node.getAttribute('href'))?.slice(0, 140),
      label: (node.getAttribute('aria-label') || node.textContent || '').trim().slice(0, 100)
    })));
}

async function performAction(frame, step) {
  const target = step.selector ? frame.locator(step.selector) : frame.locator('body');
  const options = { timeout: actionTimeout };
  switch (step.action) {
    case 'inspect':
      return {
        dom: await snapshot(target),
        controls: await visibleControls(target)
      };
    case 'click':
      await target.click(options);
      break;
    case 'fill':
      await target.fill(step.value, options);
      break;
    case 'press':
      await target.press(step.value, options);
      break;
    case 'scroll':
      await target.evaluate((element, useContainer) => {
        const viewport = useContainer ? element : element.ownerDocument.scrollingElement;
        viewport.scrollTop = viewport.scrollHeight;
      }, Boolean(step.selector), options);
      break;
    case 'scroll_until': {
      const deadline = Date.now() + 8000;
      let scrolls = 0;
      do {
        if (await target.first().isVisible()) return {};
        await frame.locator('body').evaluate((body) => {
          const viewport = body.ownerDocument.scrollingElement;
          viewport.scrollTop = viewport.scrollHeight;
        }, undefined, options);
        scrolls++;
        await new Promise((resolve) => setTimeout(resolve, 300));
      } while (scrolls < 24 && Date.now() < deadline);
      if (await target.first().isVisible()) return {};
      throw new Error(`滚动了 ${scrolls} 次，目标 ${step.selector} 仍未显示。`);
    }
    case 'assert_text':
      await target.getByText(step.value, { exact: false }).filter({ visible: true }).first()
        .waitFor({ ...options, state: 'visible' });
      break;
    case 'assert_count': {
      const deadline = Date.now() + actionTimeout;
      let count;
      do {
        count = await target.evaluateAll((nodes) => nodes.filter((node) => node.getClientRects().length &&
          getComputedStyle(node).visibility === 'visible').length);
        if (count >= step.minCount) return {};
        await new Promise((resolve) => setTimeout(resolve, 100));
      } while (Date.now() < deadline);
      throw new Error(`预期至少 ${step.minCount} 个可见元素，实际匹配到 ${count} 个。`);
    }
    default:
      throw new Error('Unsupported action');
  }
  return {};
}

export async function browserTest({ files, actions }, { executablePath } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'builder-browser-'));
  const guest = new Guest(directory);
  let browser;
  const steps = [];
  const errors = [];
  const api = [];
  try {
    try {
      await guest.send({ type: 'load', source: files['server.js'], setup: true }, 7000);
    } catch (error) {
      return { status: 'failed', error: 'Cannot start candidate backend: ' + String(error.message).slice(0, 200), steps };
    }
    try {
      browser = await chromium.launch({ executablePath, headless: true, timeout: 7500, args: ['--disable-dev-shm-usage'] });
    } catch (error) {
      process.stderr.write(String(error.message).slice(0, 1000) + '\n');
      return { status: 'unavailable', error: 'Isolated Chromium could not start.', steps };
    }
    const context = await browser.newContext({ viewport: { width: 1050, height: 730 } });
    await context.route('**/*', (route) => route.request().url() === fixtureUrl
      ? route.fulfill({ contentType: 'text/html; charset=utf-8',
          body: '<!doctype html><html><head><style>body{margin:0}iframe{width:100vw;height:100vh;border:0}</style></head><body></body></html>' })
      : route.abort());
    const page = await context.newPage();
    await page.addInitScript({ content: 'window.builderUpdatePreviewStorage = ' + previewStorageUpdate.toString() });
    page.on('pageerror', (error) => {
      if (errors.length < 5) errors.push(error.message.slice(0, 300));
    });
    let requests = Promise.resolve();
    await page.exposeBinding('builderFixtureRequest', async ({ frame }, value) => {
      if (frame !== page.mainFrame()) return { status: 403, body: null };
      try {
        if (Buffer.byteLength(JSON.stringify(value)) > maxBody) return { status: 413, body: null };
        const input = previewInput(value);
        const result = requests.then(() => guest.send({ type: 'request', input })).catch((error) => {
          const status = error.statusCode ?? 500;
          if (errors.length < 5) errors.push('Backend request failed: ' + String(error.message).slice(0, 260));
          return { status, body: { error: error.message } };
        });
        requests = result.then(() => undefined);
        const { status, body } = await result;
        const response = Array.isArray(body) ? { type: 'array', length: body.length }
          : body && typeof body === 'object' ? { type: 'object', keys: Object.keys(body).slice(0, 12).map((key) => key.slice(0, 64)) }
            : { type: body === null ? 'null' : typeof body };
        if (api.length >= maxApiEntries) api.shift();
        api.push({ method: input.method, path: input.path.slice(0, 240), status, response });
        return { status, body };
      } catch {
        return { status: 400, body: { error: 'Invalid preview API request' } };
      }
    });
    await page.goto(fixtureUrl, { timeout: 3500 });
    const browserFiles = { ...files };
    delete browserFiles['server.js'];
    await page.evaluate(mountFixture, { files: browserFiles, sandbox: previewSandbox, srcdoc: createPreviewDocument() });
    const frame = page.frameLocator('#preview');
    await frame.locator('html[data-builder-preview-ready]').waitFor({ state: 'attached', timeout: 3500 });
    for (const step of actions) {
      try {
        steps.push({ action: step.action, ok: true, ...await performAction(frame, step) });
      } catch (error) {
        const controls = await visibleControls(frame).catch(() => []);
        const missing = step.selector && await frame.locator(step.selector).count().then((count) => count === 0).catch(() => false);
        const errorText = missing && step.action !== 'scroll_until' ? '当前预览页找不到 ' + step.selector :
          String(error.message).split('\n')[0].slice(0, 240);
        const classToken = step.action === 'assert_text' && /^[A-Za-z_][\w-]{0,39}$/.test(step.value) ? step.value : null;
        const classMatches = classToken && await frame.locator(step.selector || 'body').evaluateAll(
          (nodes, token) => nodes.some((node) => Array.from(node.getElementsByClassName(token)).some(
            (match) => match.getClientRects().length && getComputedStyle(match).visibility === 'visible'
          )), classToken
        ).catch(() => false);
        steps.push({ action: step.action, ok: false, error: errorText, controls, classToken: classMatches ? classToken : undefined });
        break;
      }
    }
    await page.waitForFunction(() => window.builderPending === 0, undefined, { timeout: 2300 }).catch(() => {
      errors.push('A preview API request did not complete.');
    });
    const dom = await snapshot(frame.locator('body')).catch(() => '');
    return { status: steps.every((step) => step.ok) && errors.length === 0 ? 'passed' : 'failed', steps, dom, errors, api };
  } catch (error) {
    return { status: 'failed', steps, errors, api, error: String(error.message).split('\n')[0].slice(0, 420) };
  } finally {
    await browser?.close().catch(() => {});
    guest.stop();
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

if (import.meta.main) {
  const guard = setTimeout(() => process.exit(2), 30000);
  try {
    const input = JSON.parse(await text(process.stdin));
    process.stdout.write(JSON.stringify(await browserTest(input)) + '\n');
  } finally {
    clearTimeout(guard);
  }
}
