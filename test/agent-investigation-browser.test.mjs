import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserTest } from '../server/browser-runner.mjs';

const executablePath = process.env.BUILDER_TEST_CHROMIUM;
const files = {
  'index.html': '<form id="herb-form"><input id="name" name="name" required><button>保存</button></form><ul id="list"></ul><script src="app.js"></script>',
  'app.js': `
async function api(options) {
  const res = await fetch('/api/herbs', options);
  const payload = await res.json();
  return payload.body;
}
const form = document.querySelector('#herb-form');
const nameField = document.querySelector('#name');
const list = document.querySelector('#list');
let editing;
async function render() {
  const herbs = await api() ?? [];
  list.replaceChildren(...herbs.map((herb) => {
    const row = document.createElement('li');
    const edit = document.createElement('button');
    edit.textContent = '编辑';
    edit.addEventListener('click', () => { editing = herb.id; nameField.value = herb.name; });
    row.append(herb.name, edit);
    return row;
  }));
}
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  await api({ method: 'POST', body: JSON.stringify({ id: editing, name: nameField.value }) });
  await render();
});
render();
`,
  'server.js': `
function handle({ method, body }) {
  if (method === 'GET') return { status: 200, body: db.list('herbs') };
  const herb = { name: body.name };
  return { status: 200, body: body.id ? db.update('herbs', body.id, herb) : db.insert('herbs', herb) };
}
`
};
const actions = [
  { action: 'fill', selector: '#name', value: '测试药材' }, { action: 'click', selector: '#herb-form button' },
  { action: 'assert_text', selector: '#list', value: '测试药材' }, { action: 'click', selector: '#list button' },
  { action: 'fill', selector: '#name', value: '修改后的药材' }, { action: 'click', selector: '#herb-form button' },
  { action: 'assert_text', selector: '#list', value: '修改后的药材' },
  { action: 'assert_count', selector: '#list li:only-child', minCount: 1 }
];

test('a visible-text assertion can find a visible match after a hidden duplicate', {
  skip: !executablePath && 'Set BUILDER_TEST_CHROMIUM to the Chromium executable',
  timeout: 12000
}, async () => {
  const page = '<p hidden>当归片</p><p>当归片</p><!--';
  const html = page + ' '.repeat(24735 - Buffer.byteLength(page) - 3) + '-->';
  const result = await browserTest({
    files: { 'index.html': html, 'server.js': files['server.js'] },
    actions: [{ action: 'assert_text', value: '当归片' }]
  }, { executablePath });
  assert.equal(result.status, 'passed', JSON.stringify(result.steps));
});

test('real preview inspects repeated card footers and continues to a scoped interaction', {
  skip: !executablePath && 'Set BUILDER_TEST_CHROMIUM to the Chromium executable', timeout: 12000
}, async () => {
  const cards = Array.from({ length: 8 }, (_, i) =>
    `<article class="dish-card"><footer class="dish-foot"><button id="add-${i}">加购菜品 ${i}</button></footer></article>`).join('');
  const result = await browserTest({
    files: { 'index.html': cards, 'server.js': files['server.js'] },
    actions: [
      { action: 'inspect', selector: '.dish-card .dish-foot' },
      { action: 'click', selector: '#add-0' },
      { action: 'assert_count', selector: '.dish-card .dish-foot', minCount: 8 }
    ]
  }, { executablePath });
  assert.equal(result.status, 'passed', JSON.stringify(result));
  assert.equal(result.steps[0].matchCount, 8);
  assert.match(result.steps[0].dom, /加购菜品 0/);
  assert.match(result.steps[0].dom, /加购菜品 3/);
  assert.doesNotMatch(result.steps[0].dom, /加购菜品 4/);
  assert.equal(result.steps[0].controls.length, 8);
});

test('real preview accepts a rewritten static navigation selector after scoped interactions', {
  skip: !executablePath && 'Set BUILDER_TEST_CHROMIUM to the Chromium executable', timeout: 12000
}, async () => {
  const website = { ...files, 'index.html': '<button class="add" id="first">加购 A</button><button class="add">加购 B</button><a href="admin.html">后台</a>',
    'admin.html': '<h1>后台管理</h1>' };
  const ambiguous = await browserTest({ files: website, actions: [{ action: 'click', selector: '.add' }] }, { executablePath });
  assert.match(ambiguous.steps[0].error, /strict mode violation/);
  const fixed = await browserTest({ files: website, actions: [
    { action: 'click', selector: '#first' }, { action: 'click', selector: 'a[href="admin.html"]' },
    { action: 'assert_text', value: '后台管理' }
  ] }, { executablePath });
  assert.equal(fixed.status, 'passed', JSON.stringify(fixed));
});

test('the acceptance runner supports long suites and selects a native option by value', {
  skip: !executablePath && 'Set BUILDER_TEST_CHROMIUM to the Chromium executable', timeout: 12000
}, async () => {
  const website = { ...files, 'index.html': `<select id="sort"><option value="asc">升序</option><option value="desc">降序</option></select>
    <p id="result">第一项</p><script>document.querySelector('#sort').onchange = () => {
      document.querySelector('#result').textContent = '最后一项';
    };</script>` };
  const tests = Array.from({ length: 22 }, () => ({ action: 'assert_count', selector: '#sort', minCount: 1 }));
  tests.push({ action: 'select', selector: '#sort', value: 'desc' },
    { action: 'assert_text', selector: '#result', value: '最后一项', exact: true });
  const result = await browserTest({ files: website, actions: tests }, { executablePath });
  assert.equal(result.status, 'passed', JSON.stringify(result.steps.at(-1)));
  assert.equal(result.steps.length, 24);
});

test('real Chromium can open the requested page directly at a phone viewport', {
  skip: !executablePath && 'Set BUILDER_TEST_CHROMIUM to the Chromium executable', timeout: 12000
}, async () => {
  const website = { ...files, 'index.html': '<h1>概览</h1>', 'calendar.html':
    '<style>.phone{display:none;opacity:0}@media(max-width:400px){.phone{display:block}}</style>' +
    '<main><p class="phone">手机日历</p></main><script>setTimeout(() => document.querySelector(".phone").style.opacity=1, 350)</script>' };
  const result = await browserTest({ files: website, page: 'calendar.html', viewport: { width: 375, height: 812 },
    actions: [{ action: 'assert_layout', selector: '.phone', scope: 'main', metric: 'rightInset', comparison: 'min', limit: 0 },
      { action: 'assert_text', value: '手机日历' }] }, { executablePath });
  assert.equal(result.status, 'passed', JSON.stringify(result));
  assert.equal(result.steps[0].measurement.width, 375);
  assert.equal(result.steps[0].measurement.page, 'calendar.html');
});
