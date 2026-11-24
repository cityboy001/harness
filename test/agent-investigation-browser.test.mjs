import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildProject } from '../server/agent-workflow.mjs';
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
  const result = await browserTest({
    files: { 'index.html': '<p hidden>当归片</p><p>当归片</p>', 'server.js': files['server.js'] },
    actions: [{ action: 'assert_text', value: '当归片' }]
  }, { executablePath });
  assert.equal(result.status, 'passed', JSON.stringify(result.steps));
});

test('real Chromium evidence drives a scoped repair and replays the original create, list and edit scenario', {
  skip: !executablePath && 'Set BUILDER_TEST_CHROMIUM to the Chromium executable',
  timeout: 20000
}, async () => {
  const checked = [];
  const published = [];
  const output = await buildProject({ platform: true }, '先测试药材新增、列表和编辑，确有问题则修复。',
    files, async (_config, messages) => {
      const instruction = messages[0].content;
      if (instruction.startsWith('You are the central planning agent')) {
        return '{"mode":"investigate","goal":"新增、列表、编辑","allowRepair":true}';
      }
      if (instruction.startsWith('You are the browser acceptance agent')) return JSON.stringify({ tests: actions });
      if (instruction.startsWith('You are the central agent reviewing a real browser investigation')) {
        const { failure } = JSON.parse(messages[1].content);
        assert.equal(checked.length, 2, 'The current version must reproduce the defect before repair is planned');
        assert.equal(failure.failedStep.number, 3);
        assert.deepEqual(failure.api.slice(-2), [
          { method: 'POST', path: '/api/herbs', status: 200, response: { type: 'object', keys: ['name', 'id'] } },
          { method: 'GET', path: '/api/herbs', status: 200, response: { type: 'array', length: 1 } }
        ]);
        assert.doesNotMatch(JSON.stringify(failure.api), /测试药材/);
        return '{"decision":"repair","frontend":"Read the response payload directly."}';
      }
      assert.match(instruction, /frontend sub-agent/);
      assert.equal(checked.length, 2);
      if (messages.length === 2) return '{"read":["app.js"]}';
      assert.match(messages.at(-1).content, /return payload\.body/);
      return JSON.stringify({ edits: [{ path: 'app.js', before: 'return payload.body;', after: 'return payload;' }] });
    }, {
      maxTokens: 32000,
      onCandidate: (candidate) => published.push(candidate),
      async testBrowser(candidate, steps, signal) {
        signal.throwIfAborted();
        const result = await browserTest({ files: candidate, actions: steps }, { executablePath });
        checked.push({ files: candidate, steps, result });
        return result;
      }
    });

  assert.deepEqual(checked.map(({ result }) => result.status), ['passed', 'failed', 'passed']);
  assert.equal(checked[1].files, files);
  assert.deepEqual(checked[1].steps, checked[2].steps);
  assert.equal(published.length, 1);
  assert.equal(output.files, published[0]);
  assert.equal(output.files['server.js'], files['server.js']);
  assert.equal(output.files['app.js'], files['app.js'].replace('return payload.body;', 'return payload;'));
  assert.match(output.summary, /原始浏览器用例/);
});
