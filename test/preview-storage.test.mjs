import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright-core';
import { createPreviewDocument, previewSandbox, previewStorageUpdate } from '../src/preview-document.js';

const executablePath = process.env.BUILDER_TEST_CHROMIUM;

test('sandboxed project scripts can use localStorage without access to the host', {
  skip: !executablePath && 'Set BUILDER_TEST_CHROMIUM to the Chromium executable'
}, async (t) => {
  const browser = await chromium.launch({ executablePath });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const pageErrors = [];
  const submitted = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route('https://builder-preview.test/', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><main></main>' }));
  await page.route('https://builder-preview.test/blocked-submit', (route) => {
    submitted.push(route.request().url());
    return route.abort();
  });
  await page.addInitScript({ content: 'window.applyPreviewStorageUpdate = ' + previewStorageUpdate.toString() });
  await page.goto('https://builder-preview.test/');

  const files = {
    'index.html': '<form><button id="save">Save</button></form><p id="status"></p><a href="detail.html">Open details</a><script src="index.js"></script>',
    'index.js': `
      document.querySelector('form').addEventListener('submit', (event) => {
        event.preventDefault();
        window.localStorage.setItem('herb', '测试药材');
        localStorage.setItem('stock', 100);
        localStorage.setItem('temporary', true);
        localStorage.removeItem('temporary');
        let blocked = false;
        try { parent.localStorage.getItem('account'); } catch (error) { blocked = error.name === 'SecurityError'; }
        document.querySelector('#status').textContent = [
          previewStorage === localStorage, localStorage.getItem('herb'), localStorage.getItem('stock'),
          localStorage.length, localStorage.key(0), localStorage.key(2), blocked
        ].join('|');
      });
    `,
    'detail.html': '<p id="detail"></p><form action="https://builder-preview.test/blocked-submit"><button id="send" type="button">Send</button></form><p id="policy"></p><script src="detail.js"></script>',
    'detail.js': `
      document.querySelector('#detail').textContent = localStorage.getItem('herb');
      localStorage.clear();
      document.addEventListener('securitypolicyviolation', (event) => {
        document.querySelector('#policy').textContent = event.effectiveDirective;
      });
      document.querySelector('#send').addEventListener('click', () => document.querySelector('form').submit());
    `
  };
  await page.evaluate(({ srcdoc, files, sandbox }) => {
    localStorage.setItem('account', 'host-only');
    const storage = Object.create(null);
    function mount(page) {
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', sandbox);
      frame.srcdoc = srcdoc;
      frame.addEventListener('load', () => {
        const { port1, port2 } = new MessageChannel();
        port1.onmessage = ({ data }) => {
          if (data.type === 'storage') window.applyPreviewStorageUpdate(storage, data);
          else if (data.type === 'navigate' && Object.hasOwn(files, data.page)) {
            port1.close();
            mount(data.page);
          }
        };
        frame.contentWindow.postMessage({ type: 'builder-preview', page, search: '', files, storage }, '*', [port2]);
      }, { once: true });
      document.querySelector('main').replaceChildren(frame);
    }
    mount('index.html');
  }, { srcdoc: createPreviewDocument(), files, sandbox: previewSandbox });

  const frame = page.frameLocator('iframe');
  await frame.locator('#save').click();
  assert.equal(await frame.locator('#status').innerText(), 'true|测试药材|100|2|herb||true');
  await frame.getByRole('link', { name: 'Open details' }).click();
  assert.equal(await frame.locator('#detail').innerText(), '测试药材');
  assert.equal(await frame.locator('#detail').evaluate(() => window.localStorage.length), 0);
  await frame.locator('#send').click();
  await frame.getByText('form-action', { exact: true }).waitFor();
  assert.deepEqual(submitted, []);
  assert.equal(await page.evaluate(() => localStorage.getItem('account')), 'host-only');
  assert.equal(await page.evaluate(() => localStorage.getItem('herb')), null);
  assert.deepEqual(pageErrors, []);
});
