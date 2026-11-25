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

test('LangChain ReAct debits one 32000-token budget across tool calls and format correction', async () => {
  const requests = [];
  const output = await buildWebsite({ platform: true }, '回答问题', undefined, async (_model, messages, tokens, options) => {
    requests.push([tokens, options.toolChoice]);
    if (requests.length === 1) {
      return { usage: { completion_tokens: 24000 }, message: { reasoning_content: '先记下步骤', tool_calls: [
        { id: 'plan-call', type: 'function', function: { name: 'update_plan', arguments: '{"steps":["回答问题"]}' } }
      ] } };
    }
    assert.ok(messages.some(message => message.role === 'assistant' && message.reasoning_content === '先记下步骤'));
    if (requests.length === 2) {
      assert.ok(messages.some(message => message.role === 'tool' && message.tool_call_id === 'plan-call'));
      return { usage: { completion_tokens: 160 }, message: { content: '直接答复的错误格式' } };
    }
    assert.ok(messages.some(message => message.content.includes('格式错误')));
    return '{"answer":"答案"}';
  }, { maxTokens: 32000, react: true });
  assert.deepEqual(requests, [[32000, undefined], [8000, 'none'], [7840, 'none']]);
  assert.deepEqual(output, { files: null, summary: '答案' });
});

test('LangChain ReAct runs dependent tools in the order returned by the model', async () => {
  const events = [];
  let calls = 0;
  const result = await buildWebsite({ platform: true }, '生成站点', undefined, async (_model, messages) => {
    if (calls++ === 0) {
      return { message: { tool_calls: [
        { id: 'stage', type: 'function', function: { name: 'stage_changes', arguments: JSON.stringify({ files: project }) } },
        { id: 'check', type: 'function', function: { name: 'test_preview',
          arguments: JSON.stringify({ candidate: 'candidate-1', actions: [{ action: 'assert_text', value: 'Old title' }] }) } }
      ] } };
    }
    const results = messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content).status);
    assert.deepEqual(results, ['ok', 'passed']);
    return '{"summary":"已检查","candidate":"candidate-1"}';
  }, {
    maxTokens: 32000, react: true, requireBrowser: true,
    onActivity: event => events.push(event.detail),
    testBrowser: async (_files, actions) => ({ status: 'passed', steps: actions.map(({ action }) => ({ action, ok: true })) })
  });
  assert.deepEqual(events, ['已保存候选 candidate-1', '浏览器检查通过']);
  assert.equal(result.files['index.html'], project['index.html']);
});

test('ReAct delegates parallel scoped helpers and debits their actual usage from the parent budget', { timeout: 5000 }, async () => {
  const started = Promise.withResolvers();
  const firstRound = new Set();
  const budgetRequests = [];
  const activity = [];
  const delegated = [
    { title: '源码检查', objective: '读首页并确认标题', paths: ['index.html'] },
    { title: '浏览器检查', objective: '检查可见标题并用沙箱计算', paths: [] }
  ];
  const call = (id, name, args, tokens) => ({
    usage: { completion_tokens: tokens },
    message: { tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }
  });
  const answer = (content, tokens) => ({ usage: { completion_tokens: tokens }, message: { content } });
  const output = await buildWebsite({ platform: true }, '检查网站', project, async (_config, messages, tokens, options) => {
    const results = messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
    if (!messages[0].content.includes('临时建站辅助 Agent')) {
      budgetRequests.push(tokens);
      if (!results.length) return call('delegate', 'delegate_tasks', { tasks: delegated }, 1000);
      assert.deepEqual(results[0].results, [
        { title: '源码检查', status: 'done', summary: '首页标题来自 index.html。' },
        { title: '浏览器检查', status: 'done', summary: '浏览器看到标题，计算得 42。' }
      ]);
      return '{"answer":"检查完成"}';
    }
    const { title } = JSON.parse(messages[1].content);
    const tools = options.tools.map(t => t.function.name);
    assert.ok(!tools.some(t => ['delegate_tasks', 'stage_changes', 'open_preview', 'close_preview'].includes(t)));
    if (!firstRound.has(title)) {
      assert.equal(tokens, 6000);
      firstRound.add(title);
      if (firstRound.size === 2) started.resolve();
      await started.promise;
    }
    if (title === '源码检查') {
      if (!results.length) return call('read', 'read_files', { paths: ['index.html', 'server.js'] }, 100);
      assert.equal(results[0].files[0].content, project['index.html']);
      assert.ok(results[0].files[1].error);
      return answer('首页标题来自 index.html。', 200);
    }
    assert.deepEqual(tools, ['test_preview', 'run_code']);
    if (!results.length) return call('check', 'test_preview', { actions: [{ action: 'assert_text', value: 'Old title' }] }, 100);
    if (results.length === 1) {
      assert.equal(results[0].status, 'passed');
      return call('code', 'run_code', { source: 'console.log(42)' }, 50);
    }
    assert.equal(results[1].output, '42');
    return answer('浏览器看到标题，计算得 42。', 100);
  }, {
    react: true, maxTokens: 32000,
    onActivity: event => activity.push(event),
    async testBrowser(files, steps) {
      assert.equal(files['index.html'], project['index.html']);
      assert.equal(steps[0].value, 'Old title');
      return { status: 'passed', steps: [{ action: 'assert_text', ok: true }] };
    },
    async runCode(source) {
      assert.equal(source, 'console.log(42)');
      return { exitCode: 0, output: '42' };
    }
  });
  assert.deepEqual(budgetRequests, [32000, 30450]);
  assert.deepEqual(activity.map(event => event.detail), ['子 Agent 开始', '子 Agent 开始', '子 Agent 完成', '子 Agent 完成']);
  assert.deepEqual(output, { files: null, summary: '检查完成' });
});

test('parallel editors submit scoped patches and the main agent merges and tests the combined candidate', async () => {
  const files = { ...project, 'app.js': 'const title = "Old";', 'style.css': 'h1 { color: red; }' };
  const tasks = [
    { title: '脚本', objective: '修改脚本', paths: [], writePaths: ['app.js'] },
    { title: '样式', objective: '修改样式', paths: [], writePaths: ['style.css'] }
  ];
  let toolId = 0;
  const call = (name, args) => ({ usage: { completion_tokens: 100 },
    message: { tool_calls: [{ id: 'edit-test-' + ++toolId, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } });
  const stage = [];
  const checked = [];
  let parentTurn = 0;
  const output = await buildWebsite({ platform: true }, '分别修改脚本和样式', files, async (_, messages, _budget, options) => {
    const results = messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
    if (messages[0].content.includes('临时建站辅助 Agent')) {
      const { writePaths: [path] } = JSON.parse(messages[1].content);
      assert.ok(options.tools.some(t => t.function.name === 'submit_patch'));
      if (!results.length) return call('read_files', { paths: [path] });
      if (results.length === 1 && path === 'app.js') return call('submit_patch', { changes: { 'index.html': '<h1>越权</h1>' } });
      if (results.length === 1 || (path === 'app.js' && results.length === 2)) {
        if (path === 'app.js') assert.match(results.at(-1).error, /范围之外/);
        const value = path === 'app.js' ? 'const title = "New";' : 'h1 { color: blue; }';
        return call('submit_patch', { changes: { [path]: value } });
      }
      assert.deepEqual(results.at(-1), { status: 'ok', files: [path] });
      return '完成本文件修改。';
    }
    switch (++parentTurn) {
      case 1: return call('delegate_tasks', { tasks: [tasks[0], { ...tasks[1], writePaths: ['APP.js'] }] });
      case 2:
        assert.match(results.at(-1).error, /冲突或重复/);
        return call('delegate_tasks', { tasks });
      case 3:
        assert.equal(results.at(-1).batch, 'batch-1');
        assert.deepEqual(results.at(-1).results.map(r => r.files), [['app.js'], ['style.css']]);
        assert.equal(stage.length, 0);
        return call('stage_changes', { changes: { 'notice.html': '<h1>公告</h1>' } });
      case 4: return call('merge_delegated_changes', { batch: 'batch-1' });
      case 5:
        assert.equal(results.at(-1).candidate, 'candidate-2');
        return call('test_preview', { candidate: 'candidate-2', actions: [{ action: 'assert_text', value: 'Old title' }] });
      default:
        assert.equal(results.at(-1).status, 'passed');
        return '{"summary":"脚本和样式已合并并检查","candidate":"candidate-2"}';
    }
  }, { maxTokens: 32000, react: true, requireBrowser: true, onCandidate: files => stage.push(files),
    async testBrowser(files, actions) {
      checked.push(files);
      return { status: 'passed', steps: actions.map(({ action }) => ({ action, ok: true })) };
    }
  });
  assert.deepEqual(checked, [output.files]);
  assert.equal(output.files['app.js'], 'const title = "New";');
  assert.equal(output.files['style.css'], 'h1 { color: blue; }');
  assert.equal(output.files['notice.html'], '<h1>公告</h1>');
  assert.equal(output.files['index.html'], project['index.html']);
});

test('merging a delegated patch rejects a file changed since delegation', async () => {
  const files = { ...project, 'app.js': 'old();' };
  let turn = 0;
  const call = (id, name, args) => ({ message: { tool_calls: [
    { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
  ] } });
  const saved = [];
  await buildWebsite({ platform: true }, '修改脚本', files, async (_, messages) => {
    const results = messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
    if (messages[0].content.includes('临时建站辅助 Agent')) {
      if (!results.length) return call('child-read', 'read_files', { paths: ['app.js'] });
      if (results.length === 1) return call('child-write', 'submit_patch', { changes: { 'app.js': 'child();' } });
      return '辅助改动已完成';
    }
    switch (++turn) {
      case 1: return call('parent-delegate', 'delegate_tasks', { tasks: [
        { title: '改脚本', objective: '辅助改动', paths: [], writePaths: ['app.js'] }
      ] });
      case 2: return call('parent-read', 'read_files', { paths: ['app.js'] });
      case 3: return call('parent-write', 'stage_changes', { changes: { 'app.js': 'parent();' } });
      case 4: return call('parent-merge', 'merge_delegated_changes', { batch: 'batch-1' });
      default:
        assert.match(results.at(-1).error, /分派后以下文件已修改/);
        assert.deepEqual(results.at(-1).files, ['app.js']);
        return '{"answer":"检测到冲突"}';
    }
  }, { react: true, maxTokens: 32000, onCandidate: files => saved.push(files) });
  assert.deepEqual(saved.map(files => files['app.js']), ['parent();']);
});

test('editor helpers accumulate small patches, preserve a partial patch after truncation, and can submit during finalization', async () => {
  const call = (id, name, args, used = 100) => ({ usage: { completion_tokens: used }, message: { tool_calls: [
    { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
  ] } });
  let parent = 0;
  const activity = [];
  const output = await buildWebsite({ platform: true }, '并行添加页面文件', project, async (_, messages, tokens, options) => {
    const observations = messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
    if (!messages[0].content.includes('临时建站辅助 Agent')) {
      switch (++parent) {
        case 1: return call('delegate', 'delegate_tasks', { tasks: [
          { title: '脚本', objective: '新增两个脚本', paths: [], writePaths: ['a.js', 'b.js'] },
          { title: '样式', objective: '新增样式', paths: [], writePaths: ['style.css'] }
        ] });
        case 2:
          assert.equal(observations[0].results[0].status, 'partial');
          assert.match(observations[0].results[0].error, /预算/);
          assert.deepEqual(observations[0].results[0].files, ['a.js', 'b.js']);
          assert.equal(observations[0].results[1].status, 'done');
          return call('merge', 'merge_delegated_changes', { batch: observations[0].batch });
        default: return JSON.stringify({ summary: '并行改动已合并', candidate: observations.at(-1).candidate });
      }
    }
    const { title } = JSON.parse(messages[1].content);
    if (title === '脚本') {
      if (!observations.length) return call('first', 'submit_patch', { changes: { 'a.js': 'const a = 1;' } });
      if (observations.length === 1) return call('second', 'submit_patch', { changes: { 'b.js': 'const b = 2;' } });
      throw new ModelOutputLimitError();
    }
    if (!observations.length && tokens === 9000) return call('first', 'submit_patch', { changes: {} }, 8640);
    assert.equal(tokens, 360);
    assert.equal(options.toolChoice, 'none');
    return '{"changes":{"style.css":"h1 { color: blue; }"},"summary":"样式完成"}';
  }, { maxTokens: 32000, react: true, onActivity: event => activity.push(event) });
  assert.deepEqual([output.files['a.js'], output.files['b.js'], output.files['style.css']],
    ['const a = 1;', 'const b = 2;', 'h1 { color: blue; }']);
  assert.ok(activity.some(event => event.detail === '子 Agent 部分完成' && event.decision.includes('预算')));
});
