import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildWebsite } from '../server/generation.mjs';
import { createBrowserTools, previewActions, previewActionError } from '../server/generation-browser.mjs';
import { loadProjectMemory } from '../server/project-memory.mjs';
import { openStore } from '../server/storage.mjs';

const model = { platform: true };
const maxTokens = 32000;
const files = {
  'index.html': '<h1>项目内容</h1>',
  'server.js': 'function handle() { return {status: 200, body: []}; }'
};
const browserActions = [{ action: 'scroll' }, { action: 'assert_count', selector: '.card', minCount: 24 }];
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const tools = (...tool_calls) => ({ message: { tool_calls } });
const toolResults = (messages) => messages.filter(({ role }) => role === 'tool')
  .map(({ tool_call_id, content }) => [tool_call_id, JSON.parse(content)]);
const done = '{"answer":"Done"}';

test('file reads preserve per-path results, call IDs and exact source text through the model protocol', async () => {
  const reads = [
    call('first', 'read_files', { paths: ['index.html', 'missing.js', '../server.js', 'index.html'] }),
    call('bad', 'read_files', { paths: ['server.js', 123] }),
    call('second', 'read_files', { paths: ['server.js'] })
  ];
  const result = await buildWebsite(model, 'Read these project files.', files, async (_config, messages, _budget, options) => {
    if (messages.length === 2) {
      assert.deepEqual(options.tools.map((tool) => tool.function.name), ['read_files']);
      return tools(...reads);
    }
    assert.deepEqual(messages[2].tool_calls, reads);
    assert.deepEqual(toolResults(messages), [
      ['first', { remaining_calls: 5, files: [
        { path: 'index.html', content: files['index.html'] },
        { path: 'missing.js', error: 'Path not found in this project version.' },
        { path: '../server.js', error: 'Path not found in this project version.' },
        { path: 'index.html', status: 'Already supplied in an earlier result.' }
      ] }],
      ['bad', { error: 'Provide one to eight paths from the manifest.' }],
      ['second', { remaining_calls: 3, files: [{ path: 'server.js', content: files['server.js'] }] }]
    ]);
    return done;
  }, { maxTokens });
  assert.deepEqual(result, { files: null, summary: 'Done' });
});

test('file reader enforces batch, call count, unique file count and UTF-8 byte limits', async (t) => {
  const paths = Array.from({ length: 24 }, (_, i) => 'page-' + i + '.js');
  const batches = [
    { name: '0, 8 and 9 paths in one call', inputs: [[], paths.slice(0, 8), paths.slice(0, 9)],
      check(rows) {
        assert.match(rows[0].error, /one to eight/);
        assert.equal(rows[1].files.length, 8);
        assert.ok(rows[1].files.every(({ content }) => content === 'x'));
        assert.match(rows[2].error, /one to eight/);
      } },
    { name: '6 calls then a rejected seventh call', inputs: paths.slice(0, 7).map((path) => [path]),
      check(rows) {
        assert.deepEqual(rows.slice(0, 6).map(({ remaining_calls }) => remaining_calls), [5, 4, 3, 2, 1, 0]);
        assert.match(rows[6].error, /No further file reads/);
      } },
    { name: '18 successfully read files and a rejected 19th file',
      inputs: [paths.slice(0, 8), paths.slice(8, 16), paths.slice(16, 19), paths.slice(19, 20)],
      check(rows) {
        assert.equal(rows.flatMap(({ files: entries = [] }) => entries).filter(({ content }) => content === 'x').length, 18);
        assert.deepEqual(rows[2].files[2], { path: paths[18], error: 'File reading budget exceeded. Use the files already supplied or narrow the change.' });
        assert.match(rows[3].error, /No further file reads/);
      } },
    { name: '96000 bytes exactly, with an oversized file refused before the final permitted byte',
      inputs: [paths.slice(0, 6)], sources: {
        [paths[0]]: '汉'.repeat(8000), [paths[1]]: '汉'.repeat(8000),
        [paths[2]]: '汉'.repeat(8000), [paths[3]]: '汉'.repeat(7999) + 'ab',
        [paths[4]]: '汉', [paths[5]]: 'z'
      },
      check(rows) {
        const entries = rows[0].files;
        assert.match(entries[4].error, /budget exceeded/);
        assert.equal(entries[5].content, 'z');
        assert.equal(entries.reduce((sum, item) => sum + Buffer.byteLength(item.content ?? ''), 0), 96000);
      } }
  ];
  for (const { name, inputs, sources, check } of batches) {
    await t.test(name, async () => {
      const manifest = { ...files, ...Object.fromEntries(paths.map((path) => [path, 'x'])), ...sources };
      const calls = inputs.map((batch, index) => call('batch-' + index, 'read_files', { paths: batch }));
      let submitted = 0;
      await buildWebsite(model, 'Read the source.', manifest, async (_config, messages) => {
        if (submitted < calls.length) {
          const next = calls.slice(submitted, submitted + 4);
          submitted += next.length;
          return tools(...next);
        }
        const results = toolResults(messages);
        assert.deepEqual(results.map(([id]) => id), calls.map(({ id }) => id));
        check(results.map(([, value]) => value));
        return done;
      }, { maxTokens });
    });
  }
});

test('tool dispatcher rejects an entire invalid batch before calling any valid tool', async (t) => {
  const preview = call('preview', 'test_preview', { actions: [{ action: 'inspect' }] });
  for (const [name, batch] of [
    ['duplicate id', [preview, { ...preview }]],
    ['empty id', [preview, { ...preview, id: '' }]],
    ['unknown tool', [preview, call('unknown', 'other_tool', {})]],
    ['known but unavailable tool', [preview, call('history', 'search_project_history', { query: 'test' })]],
    ['5 calls', Array.from({ length: 5 }, (_, index) => ({ ...preview, id: 'call-' + index }))]
  ]) {
    await t.test(name, async () => {
      let modelCalls = 0;
      await assert.rejects(buildWebsite(model, 'Inspect the page.', files, async () => {
        modelCalls++;
        return tools(...batch);
      }, { maxTokens, testBrowser() { assert.fail('Invalid batch must have no browser side effect'); } }),
      { statusCode: 422, message: /无效的工具操作/ });
      assert.equal(modelCalls, 1);
    });
  }
});

test('malformed tool JSON returns a structured error to the matching call and can be corrected', async () => {
  const malformed = { id: 'bad-json', function: { name: 'read_files', arguments: '{"paths":' } };
  const answer = await buildWebsite(model, 'Read source.', files, async (_config, messages) => {
    const results = toolResults(messages);
    if (!results.length) return tools(malformed);
    assert.deepEqual(results[0], ['bad-json', { error: 'Provide one to eight paths from the manifest.' }]);
    if (results.length === 1) return tools(call('correct', 'read_files', { paths: ['index.html'] }));
    assert.deepEqual(results[1], ['correct', { files: [{ path: 'index.html', content: files['index.html'] }], remaining_calls: 4 }]);
    return done;
  }, { maxTokens });
  assert.equal(answer.summary, 'Done');
});

test('browser actions validate and normalize all supported operation arguments', async (t) => {
  const layout = { action: 'assert_layout', scope: '#toolbar', selector: '#save', reference: '#label',
    metric: 'horizontalGap', comparison: 'increase', acceptanceId: 'toolbar-gap' };
  const valid = [
    { action: 'inspect' }, { action: 'click', selector: '#open' }, { action: 'fill', selector: '#q', value: '' },
    { action: 'press', selector: '#q', value: 'Enter' }, { action: 'scroll', selector: '#list' },
    { action: 'scroll_until', selector: '#end' }, { action: 'assert_text', value: 'Reached end' },
    { action: 'assert_count', selector: '.card', minCount: 1 },
    { action: 'assert_count', selector: '.missing', maxCount: 0 }, layout
  ];
  assert.deepEqual(JSON.parse(JSON.stringify(previewActions(valid))), valid);
  assert.equal(previewActions(Array(20).fill(valid[0])).length, 20);
  const longest = { action: 'assert_text', selector: 'x'.repeat(240), value: 'x'.repeat(300) };
  assert.equal(previewActionError([longest, { ...valid[7], minCount: 500 }]), null);
  for (const [name, input, expected] of [
    ['not an array', {}, /步骤数组/], ['empty', [], /步骤数量/], ['21 steps', Array(21).fill(valid[0]), /步骤数量/],
    ['null step', [null], /必须是包含 action 的对象/], ['unknown action', [{ action: 'wait' }], /wait/],
    ['click without selector', [{ action: 'click' }], /selector/],
    ['invalid selector length', [{ ...longest, selector: 'x'.repeat(241) }], /selector/],
    ['missing fill value', [{ action: 'fill', selector: '#q' }], /fill.value/],
    ['invalid key', [{ ...valid[3], value: 'Unsupported' }], /press.value/],
    ['scroll selector must be a string', [{ ...valid[4], selector: true }], /selector/],
    ['scroll_until needs a target', [{ action: 'scroll_until' }], /selector/],
    ['blank assertion', [{ ...valid[6], value: '  ' }], /assert_text.value/],
    ['long assertion', [{ ...longest, value: 'x'.repeat(301) }], /assert_text.value/],
    ['count below minimum', [{ ...valid[7], minCount: 0 }], /minCount/],
    ['count above maximum', [{ ...valid[7], minCount: 501 }], /minCount/],
    ['fractional count', [{ ...valid[7], minCount: 1.5 }], /minCount/],
    ['inconsistent count range', [{ ...valid[7], maxCount: 0 }], /maxCount/],
    ['layout without scope', [{ ...layout, scope: undefined }], /scope/],
    ['gap without reference', [{ ...layout, reference: undefined }], /reference/],
    ['directional layout with fabricated limit', [{ ...layout, limit: 1 }], /limit/],
    ['absolute layout without a threshold', [{ ...layout, comparison: 'min' }], /limit/],
    ['invalid acceptance ID', [{ ...layout, acceptanceId: 'Gap!' }], /acceptanceId/]
  ]) {
    await t.test(name, () => {
      assert.match(previewActionError(input), expected);
      assert.equal(previewActions(input), null);
    });
  }
});

test('preview calls pass the exact merged draft and return failed and passed step evidence on retest', async () => {
  const changes = { 'gallery.js': 'const initialCount = 12;' };
  const draft = { ...files, ...changes };
  const failed = { status: 'failed', steps: [{ action: 'scroll', ok: true },
    { action: 'assert_count', ok: false, error: 'Expected 24 cards, found 12', controls: ['#next'] }], dom: '12 cards' };
  const passed = { status: 'passed', steps: [{ action: 'scroll', ok: true },
    { action: 'assert_count', ok: true }], dom: '24 cards', errors: [] };
  let checked = 0;
  const result = await buildWebsite(model, 'Add gallery loading.', files, async (_config, messages, _budget, options) => {
    const results = toolResults(messages);
    if (!results.length) {
      assert.ok(options.tools.some((tool) => tool.function.name === 'test_preview'));
      return tools(call('draft', 'test_preview', { actions: browserActions, changes }));
    }
    assert.deepEqual(results[0], ['draft', { ...failed, candidate: 'candidate-1' }]);
    if (results.length === 1) {
      return tools(call('retest', 'test_preview', { actions: browserActions, candidate: results[0][1].candidate }));
    }
    assert.deepEqual(results[1], ['retest', { ...passed, candidate: 'candidate-1' }]);
    return '{"candidate":"candidate-1","summary":"Gallery"}';
  }, { maxTokens, async testBrowser(candidate, actions, signal) {
    assert.deepEqual({ ...candidate }, draft);
    assert.deepEqual(JSON.parse(JSON.stringify(actions)), browserActions);
    assert.ok(signal instanceof AbortSignal);
    return ++checked === 1 ? failed : passed;
  } });
  assert.equal(checked, 2);
  assert.deepEqual({ ...result.files }, draft);
  assert.match(result.summary, /已执行 2 项操作或断言/);
  assert.equal(Object.hasOwn(files, 'gallery.js'), false);
});

test('invalid preview inputs are rejected before building or opening a candidate', async (t) => {
  const actions = [{ action: 'inspect' }];
  for (const [name, prior, input, expected] of [
    ['missing actions', undefined, { files }, /步骤数组/],
    ['more than one draft field', undefined, { actions, files, candidate: 'candidate-1' }, /one draft field/],
    ['new project with incremental changes', undefined, { actions, changes: files }, /one draft field/],
    ['existing project with full replacement', files, { actions, files }, /one draft field/],
    ['unknown candidate', files, { actions, candidate: 'candidate-99' }, /unknown/],
    ['missing first draft', undefined, { actions }, /needs draft files/]
  ]) {
    await t.test(name, async () => {
      const browser = createBrowserTools(() => assert.fail('Unexpected browser call'), prior,
        () => assert.fail('Unexpected draft construction'), AbortSignal.timeout(1000));
      const result = await browser.call(input);
      assert.equal(result.status, 'invalid');
      assert.match(result.error, expected);
      assert.equal(Object.hasOwn(result, 'candidate'), false);
    });
  }
});

test('a preview tool call reports invalid draft files to the model without running the browser', async () => {
  await buildWebsite(model, 'Add a gallery.', files, async (_config, messages) => {
    const results = toolResults(messages);
    if (!results.length) {
      return tools(call('bad-draft', 'test_preview', {
        actions: [{ action: 'inspect' }], changes: { '../invalid.js': 'invalid path' }
      }));
    }
    const [[id, result]] = results;
    assert.equal(id, 'bad-draft');
    assert.equal(result.status, 'invalid');
    assert.match(result.error, /不支持的文件路径/);
    assert.equal(Object.hasOwn(result, 'candidate'), false);
    return done;
  }, { maxTokens, testBrowser() { assert.fail('Invalid draft cannot open the browser'); } });
});

test('preview distinguishes unavailable, exhausted, and a different untested final version', async () => {
  const draft = { ...files, 'index.html': '<h1>Tested</h1>' };
  const different = { ...files, 'index.html': '<h1>Not the same draft</h1>' };
  const checked = [];
  const browser = createBrowserTools(async (incoming, actions) => {
    checked.push([incoming, actions.map(({ action }) => action)]);
    if (checked.length === 1) return { status: 'unavailable', error: 'Chromium unavailable for this call' };
    if (checked.length === 2) return { status: 'passed', steps: [{ action: 'assert_text', ok: true }] };
    return { status: 'failed', error: 'Untested draft does not load' };
  }, undefined, (input) => ({ files: input.files }), AbortSignal.timeout(1000));
  const first = await browser.call({ files: draft, actions: [{ action: 'assert_text', value: 'Tested' }] });
  assert.deepEqual(first, { status: 'unavailable', error: 'Chromium unavailable for this call', candidate: 'candidate-1' });
  const second = await browser.call({ candidate: first.candidate, actions: [{ action: 'assert_text', value: 'Tested' }] });
  assert.deepEqual(second, { status: 'passed', steps: [{ action: 'assert_text', ok: true }], candidate: 'candidate-1' });
  const exhausted = await browser.call({ candidate: first.candidate, actions: browserActions });
  assert.equal(exhausted.status, 'unavailable');
  assert.match(exhausted.error, /budget is exhausted/);
  assert.deepEqual((await browser.finish(first.candidate, { summary: 'Tested' })).files, draft);
  await assert.rejects(browser.finish(undefined, { files: different, summary: 'Different' }), /Untested draft does not load/);
  assert.deepEqual(checked, [[draft, ['assert_text']], [draft, ['assert_text']], [different, ['inspect']]]);
});

test('history tool returns exact scoped data and enforces the lookup limit and invalid-argument contract', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-tool-history-'));
  const store = openStore(root);
  t.after(async () => {
    store.db.close();
    await rm(root, { recursive: true, force: true });
  });
  store.run('INSERT INTO users VALUES (?, ?, ?)', 'owner', 'owner', 'fixture');
  for (const project of ['project-a', 'project-b']) {
    store.run('INSERT INTO projects VALUES (?, ?, ?, ?, NULL)', project, 'owner', project, 0);
  }
  const id = (value) => String(value).padStart(32, '0');
  const add = (project, number, state, prompt) => store.run(
    'INSERT INTO messages (id,project_id,prompt,model_id,model_name,state,response,created) VALUES (?,?,?,?,?,?,?,?)',
    id(number), project, prompt, 'platform', 'DeepSeek', state, 'Recorded reply', number);
  add('project-a', 1, 'complete', 'The original exact Decision is 42.');
  add('project-b', 2, 'complete', 'A different Decision from project B.');
  add('project-a', 3, 'running', 'An unfinished Decision.');
  for (const n of [4, 5, 6, 7]) add('project-a', n, 'complete', 'Recent turn ' + n);
  let summaryErrors = 0;
  const memory = await loadProjectMemory(store, 'project-a', model, async () => 'bad summary', () => summaryErrors++);
  assert.equal(summaryErrors, 1);
  const expected = { id: id(1), state: 'complete', request: 'The original exact Decision is 42.', reply: 'Recorded reply' };
  const answer = await buildWebsite(model, 'Retrieve original decision.', files, async (_config, messages, _budget, options) => {
    const results = toolResults(messages);
    if (!results.length) {
      assert.ok(options.tools.some((tool) => tool.function.name === 'search_project_history'));
      return tools(
        call('exact', 'search_project_history', { turnId: id(1) }),
        call('query', 'search_project_history', { query: 'decision' }),
        call('invalid', 'search_project_history', { query: '?' }),
        call('exhausted', 'search_project_history', { query: 'decision' })
      );
    }
    assert.deepEqual(results, [
      ['exact', { matches: [expected] }], ['query', { matches: [expected] }],
      ['invalid', { error: 'Specify a short phrase or an exact turn ID.' }],
      ['exhausted', { error: 'No more project history lookups are available.' }]
    ]);
    return done;
  }, { maxTokens, memory });
  assert.equal(answer.summary, 'Done');
  assert.equal(memory.searches, 3);
  assert.deepEqual(JSON.parse(memory.lookup({ turnId: id(2) })), { error: 'No more project history lookups are available.' });
});
