import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { buildWebsite, mergeWorkerChanges, validateProjectFiles } from '../server/generation.mjs';
import { ModelOutputLimitError, PublicError, readCompletionStream, retryModelCompletion, TransientModelError } from '../server/models.mjs';

const project = {
  'index.html': '<h1>Old title</h1>',
  'server.js': 'function handle() { return {status:200}; }',
  'unused.css': '/* A distinctive stylesheet */',
  'obsolete.js': '/* Remove this one */'
};

test('temporary model errors retry the same request, while cancellation and permanent errors stop', async () => {
  const messages = [{ role: 'user', content: '原始输入' }];
  const retries = [];
  const reasoning = [];
  let attempts = 0;
  const complete = async (_config, request, _tokens, options) => {
    assert.equal(request, messages);
    if (++attempts === 1) {
      options.onReasoning('第一轮输出');
      throw new TransientModelError(502, '连接中断');
    }
    options.onReasoning('重试后完成');
    return '完成';
  };
  assert.equal(await retryModelCompletion(complete, {}, messages, 1000, {
    onReasoning: (chunk) => reasoning.push(chunk)
  }, (attempt) => retries.push(attempt)), '完成');
  assert.deepEqual(retries, [1]);
  assert.match(reasoning.join(''), /第一轮输出.*重新尝试这一轮.*重试后完成/s);

  let permanentAttempts = 0;
  await assert.rejects(retryModelCompletion(async () => {
    permanentAttempts++;
    throw new PublicError(422, 'Key 无效');
  }, {}, messages, 1000), /Key 无效/);
  assert.equal(permanentAttempts, 1);

  const controller = new AbortController();
  let cancelledAttempts = 0;
  await assert.rejects(retryModelCompletion(async () => {
    cancelledAttempts++;
    throw new TransientModelError(502, '连接中断');
  }, {}, messages, 1000, { signal: controller.signal }, () => controller.abort()), { name: 'AbortError' });
  assert.equal(cancelledAttempts, 1);
});
const patch = {
  summary: '更新标题并删除旧脚本。',
  changes: { 'index.html': '<h1>New title</h1>', 'obsolete.js': null, 'new.css': '.heading {color: red}' }
};

test('static files support the reported page size and each worker retains a separate patch budget', async () => {
  const page = '<h1>外卖</h1><!--';
  const html = page + 'x'.repeat(24735 - Buffer.byteLength(page) - 3) + '-->';
  const result = await buildWebsite({ platform: true }, 'Build a menu.', undefined, async () =>
    JSON.stringify({ files: { 'index.html': html, 'server.js': project['server.js'] } }), { maxTokens: 32000 });
  assert.equal(Buffer.byteLength(result.files['index.html']), 24735);

  const merged = mergeWorkerChanges(result.files, [
    { 'menu.js': ' '.repeat(35000) }, { 'admin.js': ' '.repeat(35000) }
  ]);
  validateProjectFiles(merged.files);
  assert.equal(merged.files['menu.js'].length + merged.files['admin.js'].length, 70000);
  assert.throws(() => mergeWorkerChanges(result.files, [{ 'server.js': ' '.repeat(24001) }]), /server\.js.*24001.*24000/);
});

test('a worker can correct an ambiguous edit without starting another repair round', async () => {
  const original = { ...project, 'nav.js': 'const first = 0;\nconst second = 0;' };
  let turn = 0;
  const result = await buildWebsite({ platform: true }, 'Set only the second value to 1.', original, async (_config, messages) => {
    turn++;
    if (turn === 1) return '{"read":["nav.js"]}';
    if (turn === 2) return '{"edits":[{"path":"nav.js","before":"0","after":"1"}]}';
    const feedback = messages.findLast(({ role }) => role === 'user').content;
    assert.match(feedback, /nav\.js.*出现多次/);
    assert.match(feedback, /修改尚未应用/);
    return '{"edits":[{"path":"nav.js","before":"const second = 0;","after":"const second = 1;"}]}';
  }, { maxTokens: 10000, worker: 'frontend', compact: true });
  assert.equal(turn, 3);
  assert.equal(result.changes['nav.js'], 'const first = 0;\nconst second = 1;');
});

test('invalid localized edit fields are reported and can be corrected in place', async () => {
  let turn = 0;
  const result = await buildWebsite({ platform: true }, 'Update the API status.', project, async (_config, messages) => {
    turn++;
    if (turn === 1) return '{"read":["server.js"]}';
    if (turn === 2) return '{"edits":[{"path":"server.js","before":"status:200","after":201}]}';
    const feedback = messages.findLast(({ role }) => role === 'user').content;
    assert.match(feedback, /第 1 条局部替换.*server\.js.*after 必须是字符串/);
    return '{"edits":[{"path":"server.js","before":"status:200","after":"status:201"}]}';
  }, { maxTokens: 10000, worker: 'backend', compact: true });
  assert.equal(turn, 3);
  assert.match(result.changes['server.js'], /status:201/);
});

test('DeepSeek reads selected files, continues reasoning and merges only changes', async () => {
  let turn = 0;
  let text = '';
  const result = await buildWebsite({ platform: true }, 'Change the title and remove the old script.', project, async (_config, messages, budget, options) => {
    assert.equal(options.thinking, true);
    assert.equal(options.stream, true);
    assert.match(messages[0].content, /^语言要求：从第一句开始，用简体中文思考并输出 reasoning_content/);
    assert.match(messages[0].content, /每轮调用工具前后的分析、判断和后续计划都用简体中文/);
    assert.equal(options.tools[0].function.name, 'read_files');
    assert.ok(messages[1].content.includes('unused.css'));
    assert.ok(!JSON.stringify(messages).includes(project['unused.css']));
    turn++;
    if (turn === 1) {
      assert.ok(!messages[1].content.includes(project['index.html']));
      options.onReasoning('选择需要读取的文件。');
      return {
        usage: { completion_tokens: 100 },
        message: { reasoning_content: '选择需要读取的文件。', tool_calls: [{
          id: 'call-1', type: 'function', function: { name: 'read_files', arguments: '{"paths":["index.html","obsolete.js","../private.json"]}' }
        }] }
      };
    }
    assert.equal(budget, 9900);
    assert.equal(messages[2].reasoning_content, '选择需要读取的文件。');
    assert.equal(messages[3].tool_call_id, 'call-1');
    const { files } = JSON.parse(messages[3].content);
    assert.equal(files[0].content, project['index.html']);
    assert.equal(files[1].content, project['obsolete.js']);
    assert.ok(files[2].error);
    return { message: { reasoning_content: '现在可以修改。', content: JSON.stringify(patch) } };
  }, { maxTokens: 10000, onReasoning: (chunk) => { text += chunk; } });
  assert.equal(turn, 2);
  assert.equal(text, '选择需要读取的文件。\n\n现在可以修改。');
  assert.equal(result.files['server.js'], project['server.js']);
  assert.equal(result.files['unused.css'], project['unused.css']);
  assert.equal(result.files['index.html'], patch.changes['index.html']);
  assert.equal(result.files['new.css'], patch.changes['new.css']);
  assert.equal(Object.hasOwn(result.files, 'obsolete.js'), false);
  assert.equal(project['index.html'], '<h1>Old title</h1>');
});

test('an existing file cannot be replaced before it has been read', async () => {
  await assert.rejects(buildWebsite({}, 'Change the title.', project, async () => JSON.stringify(patch), { maxTokens: 10000 }),
    /没有先读取/);
});

test('the event stream assembles split reasoning, tool parameters and usage', async () => {
  const event = (value) => 'data: ' + JSON.stringify(value) + '\r\n\r\n';
  const wire = Buffer.from(
    event({ choices: [{ delta: { reasoning_content: '读取' } }] }) +
    event({ choices: [{ delta: { reasoning_content: '入口文件', tool_calls: [{ index: 0, id: 'call-1', function: { name: 'read_files', arguments: '{"paths":' } }] } }] }) +
    event({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '["index.html"]}' } }] }, finish_reason: 'tool_calls' }] }) +
    event({ choices: [], usage: { completion_tokens: 162 } }) + 'data: [DONE]\r\n\r\n'
  );
  let content = '';
  const pieces = Array.from({ length: Math.ceil(wire.length / 11) }, (_, index) => wire.subarray(index * 11, (index + 1) * 11));
  const result = await readCompletionStream(Readable.from(pieces), (delta) => { content += delta; });
  assert.equal(content, '读取入口文件');
  assert.equal(result.message.reasoning_content, content);
  assert.equal(result.message.tool_calls[0].function.arguments, '{"paths":["index.html"]}');
  assert.equal(result.finishReason, 'tool_calls');
  assert.equal(result.usage.completion_tokens, 162);
});

test('a browser tool can test a staged website and publish its tested candidate', async () => {
  const files = {
    'index.html': '<h1>Browser test</h1><input id="name"><button id="go">Go</button>',
    'server.js': 'function handle() { return {status:200}; }'
  };
  const actions = [
    { action: 'fill', selector: '#name', value: 'Sample' },
    { action: 'click', selector: '#go' },
    { action: 'assert_text', value: 'Sample' }
  ];
  let tests = 0;
  const result = await buildWebsite({ platform: true }, 'Build it.', undefined, async (_config, messages, _budget, options) => {
    assert.equal(options.tools[0].function.name, 'test_preview');
    if (messages.length === 2) return { message: { tool_calls: [{
      id: 'browser-1', type: 'function', function: { name: 'test_preview', arguments: JSON.stringify({ files, actions }) }
    }] } };
    const proof = JSON.parse(messages.at(-1).content);
    assert.equal(proof.status, 'passed');
    assert.equal(proof.dom, 'A DOM snapshot from the runner');
    return { message: { content: JSON.stringify({ candidate: proof.candidate, summary: '已完成' }) } };
  }, {
    maxTokens: 32000,
    async testBrowser(actualFiles, steps) {
      tests++;
      assert.deepEqual({ ...actualFiles }, files);
      assert.deepEqual(steps.map((step) => step.action), actions.map((step) => step.action));
      return { status: 'passed', steps, dom: 'A DOM snapshot from the runner' };
    }
  });
  assert.equal(tests, 1);
  assert.deepEqual({ ...result.files }, files);
  assert.match(result.summary, /浏览器验证通过.*3 项/);
});

test('a failed browser test rejects the selected candidate', async () => {
  await assert.rejects(buildWebsite({ platform: true }, 'Build it.', undefined,
    async () => JSON.stringify({ files: project }),
    {
      maxTokens: 32000,
      async testBrowser() { return { status: 'failed', errors: ['Uncaught ReferenceError'] }; }
    }
  ), /浏览器验证失败.*\nUncaught ReferenceError/);
});

test('a failed candidate can be retested with a unique click selector before publishing', async () => {
  const broad = '.card button';
  const unique = '#first-card button';
  let calls = 0;
  let checks = 0;
  const response = (id, selector, draft) => ({ message: { tool_calls: [{
    id, function: { name: 'test_preview', arguments: JSON.stringify({ ...draft, actions: [
      { action: 'click', selector }, { action: 'assert_text', value: 'Photo details' }
    ] }) }
  }] } });
  const output = await buildWebsite({ platform: true }, 'Build a gallery.', undefined, async (_config, messages, _tokens, options) => {
    calls++;
    if (calls === 1) return response('test-1', broad, { files: project });
    if (calls === 2) return '{"candidate":"candidate-1"}';
    if (calls === 3) {
      assert.match(messages.at(-1).content, /strict mode violation/);
      assert.notEqual(options.toolChoice, 'none');
      return response('test-2', unique, { candidate: 'candidate-1' });
    }
    return '{"candidate":"candidate-1"}';
  }, {
    maxTokens: 32000,
    async testBrowser(_files, actions) {
      checks++;
      return actions[0].selector === unique ? { status: 'passed', steps: actions } :
        { status: 'failed', error: 'strict mode violation: 12 matching elements' };
    }
  });
  assert.equal(calls, 4);
  assert.equal(checks, 2);
  assert.equal(output.files['index.html'], project['index.html']);
  assert.match(output.summary, /浏览器验证通过/);
});

test('output truncation recovers an asserted browser draft and leaves inspection-only drafts uncommitted', async () => {
  for (const action of [{ action: 'assert_text', value: 'Old title' }, { action: 'inspect' }]) {
    const result = buildWebsite({ platform: true }, 'Build a new site.', undefined, async (_config, messages) => {
      if (messages.length !== 2) throw new ModelOutputLimitError();
      return { message: { tool_calls: [{ id: 'browser', type: 'function', function: {
        name: 'test_preview', arguments: JSON.stringify({ files: project, actions: [action] })
      } }] } };
    }, { maxTokens: 32000, testBrowser: async () => ({ status: 'passed' }) });
    if (action.action === 'inspect') await assert.rejects(result, ModelOutputLimitError);
    else {
      const output = await result;
      assert.equal(output.files['index.html'], project['index.html']);
      assert.match(output.summary, /已保留验收通过的版本/);
    }
  }
});

test('repeat reads stop early and reserve a response for the final change', async () => {
  let turn = 0;
  const result = await buildWebsite({ platform: true }, 'Change the title.', project, async (_config, messages, _budget, options) => {
    turn++;
    if (turn <= 3) {
      assert.equal(options.toolChoice, undefined);
      return { message: { tool_calls: [{
        id: 'repeat-' + turn, type: 'function', function: { name: 'read_files', arguments: '{"paths":["index.html"]}' }
      }] } };
    }
    assert.equal(options.toolChoice, 'none');
    assert.equal(options.tools[0].function.name, 'read_files');
    assert.match(messages.at(-1).content, /立即返回最终 JSON/);
    return { message: { content: JSON.stringify({ changes: { 'index.html': '<h1>Fixed</h1>' } }) } };
  }, { maxTokens: 32000 });
  assert.equal(turn, 4);
  assert.equal(result.files['index.html'], '<h1>Fixed</h1>');
});

test('one read batches eight files and exhausted reads still allow browser testing', async () => {
  const files = { 'index.html': project['index.html'], 'server.js': project['server.js'] };
  for (let index = 0; index < 6; index++) files['section-' + index + '.html'] = '<div>' + index + '</div>';
  let turn = 0;
  let tests = 0;
  const tool = (name, args) => ({ message: { tool_calls: [{
    id: 'tool-' + turn, type: 'function', function: { name, arguments: JSON.stringify(args) }
  }] } });
  const output = await buildWebsite({ platform: true }, 'Update title.', files, async (_config, messages, _budget, options) => {
    turn++;
    assert.equal(options.toolChoice, undefined);
    if (turn === 1) return tool('read_files', { paths: Object.keys(files) });
    if (turn === 2) {
      assert.equal(JSON.parse(messages.at(-1).content).files.filter((item) => item.content).length, 8);
      return tool('test_preview', { changes: { 'index.html': '<h1>Fixed</h1>' }, actions: [{ action: 'inspect' }] });
    }
    return { message: { content: JSON.stringify({ candidate: JSON.parse(messages.at(-1).content).candidate }) } };
  }, { maxTokens: 32000, testBrowser: async () => { tests++; return { status: 'passed' }; } });
  assert.equal(output.files['index.html'], '<h1>Fixed</h1>');
  assert.equal(tests, 1);
});

test('questions and empty changes return answers without browser validation', async () => {
  const options = {
    maxTokens: 32000,
    async testBrowser() { assert.fail('A reply must not validate a candidate'); }
  };
  for (const files of [undefined, project]) {
    const answer = await buildWebsite({ platform: true }, 'How does it work?', files,
      async () => JSON.stringify({ answer: '首先读取数据。\n然后渲染界面。' }), options);
    assert.deepEqual(answer, { files: null, summary: '首先读取数据。\n然后渲染界面。' });
  }
  const unchanged = await buildWebsite({ platform: true }, 'Explain this.', project,
    async () => JSON.stringify({ summary: '这段代码已经处理空列表。', changes: {} }), options);
  assert.equal(unchanged.files, null);
  assert.match(unchanged.summary, /本次没有修改项目文件/);
});


test('direct answers can call the gVisor code tool with no project', async () => {
  let executed = 0;
  const result = await buildWebsite({ platform: true }, '算出结果', undefined, async (_config, messages, _limit, options) => {
    if (messages.length === 2) {
      assert.ok(options.tools.some(tool => tool.function.name === 'run_code'));
      return { message: { tool_calls: [{ id: 'code-1', type: 'function',
        function: { name: 'run_code', arguments: JSON.stringify({ source: 'console.log(6 * 7)' }) } }] } };
    }
    assert.equal(JSON.parse(messages.at(-1).content).output, '42');
    return '{"answer":"42"}';
  }, {
    maxTokens: 32000,
    async runCode(source, signal) {
      assert.equal(source, 'console.log(6 * 7)');
      assert.equal(signal.aborted, false);
      executed++;
      return { exitCode: 0, output: '42' };
    }
  });
  assert.equal(executed, 1);
  assert.deepEqual(result, { files: null, summary: '42' });
});


test('ReAct plans, reads, stages, tests and repairs a candidate using browser feedback', async () => {
  const tools = [];
  const staged = [];
  const checked = [];
  const events = [];
  const first = '<h1>Incomplete</h1>';
  const final = '<h1>Ready</h1>';
  const config = { platform: true };
  const commands = [
    ['update_plan', { steps: ['Build the page', 'Check the title'] }],
    ['stage_changes', { files: { ...project, 'index.html': first } }],
    ['test_preview', { candidate: 'candidate-1', actions: [{ action: 'assert_text', value: 'Ready' }] }],
    ['read_files', { candidate: 'candidate-1', paths: ['index.html'] }],
    ['stage_changes', { base: 'candidate-1', edits: [{ path: 'index.html', before: first, after: final }] }],
    ['test_preview', { candidate: 'candidate-2', actions: [{ action: 'assert_text', value: 'Ready' }] }]
  ];
  const result = await buildWebsite(config, 'Make the page say Ready', undefined, async (_, messages, _budget, options) => {
    if (!tools.length) assert.ok(options.tools.some(t => t.function.name === 'stage_changes'));
    const previous = messages.at(-1);
    if (tools.length === 3) assert.equal(JSON.parse(previous.content).status, 'failed');
    if (tools.length === 4) assert.equal(JSON.parse(previous.content).files[0].content, first);
    if (tools.length === 6) {
      assert.equal(JSON.parse(previous.content).status, 'passed');
      return '{"summary":"标题已修改", "candidate":"candidate-2"}';
    }
    const [name, args] = commands[tools.length];
    tools.push(name);
    return { message: { tool_calls: [{ id: 'action-' + tools.length, type: 'function',
      function: { name, arguments: JSON.stringify(args) } }] } };
  }, {
    react: true, maxTokens: 32000, requireBrowser: true,
    onCandidate: files => staged.push(files['index.html']),
    onActivity: item => events.push(item),
    testBrowser(files) {
      const html = files['index.html'];
      checked.push(html);
      const ok = html === final;
      return { status: ok ? 'passed' : 'failed', steps: [{ action: 'assert_text', ok, error: ok ? undefined : '标题未出现' }] };
    }
  });
  assert.deepEqual(checked, [first, final]);
  assert.deepEqual(staged, [first, final, final]);
  assert.equal(result.files['index.html'], final);
  assert.deepEqual(events.map(e => e.detail), ['计划', '已保存候选 candidate-1', '浏览器检查未通过',
    '已保存候选 candidate-2', '浏览器检查通过']);
});

test('ReAct accepts a streamed stage larger than 8 KiB and recovers from an oversized tool call', async () => {
  const payload = JSON.stringify({ files: { ...project, 'index.html': '<!--' + '分类'.repeat(4500) + '--><h1>菜单</h1>' } });
  const toolResponse = async (id, name, args) => {
    const event = value => 'data: ' + JSON.stringify(value) + '\n\n';
    const makeDelta = toolCall => event({ choices: [{ delta: { tool_calls: [{ index: 0, ...toolCall }] } }] });
    const wire = [
      makeDelta({ id, function: { name: name.slice(0, 5) } }),
      makeDelta({ function: { name: name.slice(5), arguments: args.slice(0, 7000) } }),
      makeDelta({ function: { arguments: args.slice(7000) } }),
      event({ choices: [{ finish_reason: 'tool_calls', delta: {} }], usage: { completion_tokens: 200 } }),
      'data: [DONE]\n\n'
    ];
    return readCompletionStream(Readable.from(wire));
  };
  const oversized = await toolResponse('too-large', 'stage_changes', JSON.stringify({ files: { 'index.html': '食'.repeat(45000) } }));
  assert.equal(oversized.message.tool_calls[0].argumentOverflow, true);
  assert.equal(oversized.message.tool_calls[0].function.arguments, '{}');
  const valid = await toolResponse('valid', 'stage_changes', payload);
  assert.equal(valid.message.tool_calls[0].function.arguments, payload);
  assert.equal(valid.message.tool_calls[0].argumentOverflow, undefined);
  let turn = 0;
  let staged = 0;
  const result = await buildWebsite({ platform: true }, '制作菜单页', undefined, async (_, messages) => {
    if (++turn === 1) return oversized;
    if (turn === 2) {
      assert.match(JSON.parse(messages.at(-1).content).error, /参数超过大小上限/);
      assert.equal(messages.at(-2).tool_calls[0].argumentOverflow, undefined);
      assert.equal(staged, 0);
      return valid;
    }
    const { candidate } = JSON.parse(messages.at(-1).content);
    return JSON.stringify({ candidate, summary: '已保存菜单页' });
  }, { react: true, maxTokens: 32000, onCandidate() { staged++; } });
  assert.match(result.files['index.html'], /<h1>菜单<\/h1>/);
  assert.equal(staged, 2);
});
