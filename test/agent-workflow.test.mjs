import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildProject } from '../server/agent-workflow.mjs';
import { ModelOutputLimitError, PublicError } from '../server/models.mjs';

const model = { platform: true };
const files = {
  'index.html': '<main><input id="term"><button id="submit">Go</button><div id="results"></div></main>',
  'server.js': 'function handle() { return {status:200,body:[]}; }'
};
const plan = {
  mode: 'team', summary: '实现搜索', contract: 'GET /api/search?q=term returns JSON array. Use #term and #submit.',
  frontend: 'Build the search box and results.', backend: 'Query records by q.',
  tests: [
    { action: 'fill', selector: '#term', value: 'sample' },
    { action: 'click', selector: '#submit' },
    { action: 'assert_text', value: 'sample' }
  ]
};
const roleOf = (message) => message.content.includes('frontend sub-agent') ? 'frontend' : 'backend';
const isPlan = (message) => message.content.startsWith('You are the central planning agent');
const isRepair = (message) => message.content.startsWith('You are the central agent diagnosing');
const read = (name) => ({ message: { content: '', tool_calls: [{
  id: 'read-' + name, type: 'function', function: { name: 'read_files', arguments: JSON.stringify({ paths: [name] }) }
}] } });

test('an existing project can assign frontend and browser QA only, and retry output truncation with a local edit', async () => {
  let workerCalls = 0;
  let browserRuns = 0;
  const actualTests = [{ action: 'click', selector: '#actual' }, { action: 'assert_text', value: 'sample' }];
  const output = await buildProject(model, 'Fix the search button.', files, async (_config, messages, tokens, options) => {
    if (isPlan(messages[0])) return JSON.stringify({ ...plan, backend: undefined, qa: 'Verify the search interaction.' });
    if (isRepair(messages[0])) {
      assert.match(messages[1].content, /输出达到上限/);
      return JSON.stringify({ frontend: 'Change just the search button.' });
    }
    if (messages[0].content.startsWith('You are the browser acceptance agent')) {
      assert.match(messages[1].content, /#actual/);
      return JSON.stringify({ tests: actualTests });
    }
    assert.equal(roleOf(messages[0]), 'frontend');
    workerCalls++;
    if (workerCalls === 1) throw new PublicError(502, '模型输出达到上限');
    assert.equal(options.thinking, false);
    assert.ok(tokens > 10000);
    if (workerCalls === 2) return '{"read":["index.html"]}';
    return JSON.stringify({ edits: [{ path: 'index.html', before: 'id="submit"', after: 'id="actual"' }] });
  }, {
    maxTokens: 32000,
    async testBrowser(candidate, steps) {
      browserRuns++;
      assert.match(candidate['index.html'], /id="actual"/);
      if (steps[0].action === 'inspect') return { status: 'passed', dom: 'button #actual' };
      assert.deepEqual(steps.map(({ action }) => action), ['click', 'assert_text']);
      assert.equal(steps[0].selector, '#actual');
      return { status: 'passed' };
    }
  });
  assert.equal(browserRuns, 2);
  assert.equal(output.files['server.js'], files['server.js']);
});

test('LangGraph runs both roles concurrently and sends a browser failure back to backend only', { timeout: 6500 }, async () => {
  const bothStarted = Promise.withResolvers();
  const started = new Set();
  const writes = [];
  const checkpoints = [];
  const events = [];
  const repaired = 'function handle() { return {status:200,body:["sample"]}; }';
  let browserRuns = 0;
  const output = await buildProject(model, 'Add full-stack search.', undefined, async (_config, messages, _tokens, options) => {
    if (isPlan(messages[0])) return JSON.stringify(plan);
    if (isRepair(messages[0])) {
      assert.match(messages[1].content, /result list empty/);
      return JSON.stringify({ backend: 'Return the matching records.' });
    }
    const role = roleOf(messages[0]);
    if (messages[1].content.includes('PROJECT FILE MANIFEST')) {
      assert.equal(role, 'backend');
      if (messages.length === 2) return options.thinking ? read('server.js') : '{"read":["server.js"]}';
      writes.push('backend repair');
      return JSON.stringify({ changes: { 'server.js': repaired } });
    }
    started.add(role);
    if (started.size === 2) bothStarted.resolve();
    await bothStarted.promise;
    writes.push(role);
    const name = role === 'frontend' ? 'index.html' : 'server.js';
    return JSON.stringify({ changes: { [name]: files[name] } });
  }, {
    maxTokens: 32000,
    onProgress: (text) => checkpoints.push(text),
    onAgentEvent: (event) => events.push(event),
    async testBrowser(candidate, steps) {
      browserRuns++;
      assert.equal(candidate['index.html'], files['index.html']);
      assert.deepEqual(steps.map(({ action }) => action), ['fill', 'click', 'assert_text']);
      if (browserRuns === 1) return { status: 'failed', steps: [
        { action: 'fill', ok: true }, { action: 'click', ok: true },
        { action: 'assert_text', ok: false, error: 'result list empty' }
      ] };
      assert.equal(candidate['server.js'], repaired);
      return { status: 'passed' };
    }
  });
  assert.equal(browserRuns, 2);
  assert.deepEqual([...started].sort(), ['backend', 'frontend']);
  assert.equal(writes.filter((role) => role === 'frontend').length, 1);
  assert.ok(checkpoints.some((text) => text.includes('重新规划的修复任务')));
  assert.ok(events.some((event) => event.kind === 'assign' && event.role === 'frontend' && event.round === 0));
  const failure = events.findIndex((event) => event.kind === 'check' && event.step === 3 && event.expected === 'sample');
  const repair = events.findIndex((event) => event.kind === 'assign' && event.role === 'backend' && event.round === 1);
  assert.ok(failure >= 0 && repair > failure);
  assert.ok(events.some((event) => event.kind === 'check' && event.state === 'done' && event.round === 1));
  assert.equal(output.files['server.js'], repaired);
  assert.match(output.summary, /通过浏览器验收（修复 1 轮）/);
});

test('the direct route preserves questions and skips team execution', async () => {
  const output = await buildProject(model, 'What does this do?', files, async (_config, messages) => {
    if (isPlan(messages[0])) return '{"mode":"direct"}';
    assert.ok(!messages[0].content.includes('sub-agent'));
    return '{"answer":"这是搜索界面。"}';
  }, { maxTokens: 32000, async testBrowser() { assert.fail('Questions should not open a browser.'); } });
  assert.deepEqual(output, { files: null, summary: '这是搜索界面。' });
});

test('direct output truncation retries with exact edits and still verifies them in the browser', async () => {
  let browserRuns = 0;
  let truncations = 0;
  const events = [];
  const output = await buildProject(model, 'Add a search hint.', files, async (_config, messages, _tokens, options) => {
    if (isPlan(messages[0])) return '{"mode":"direct"}';
    if (options.thinking) {
      truncations++;
      throw new ModelOutputLimitError();
    }
    assert.match(messages[0].content, /previous output was truncated/);
    if (messages.length === 2) return '{"read":["index.html"]}';
    if (messages.length === 4) return { message: { tool_calls: [{
      id: 'browser-1', function: { name: 'test_preview', arguments: JSON.stringify({
        edits: [{ path: 'index.html', before: 'id="term"', after: 'id="term" placeholder="Search"' }],
        changes: { 'help.html': '<p>Search hint</p>' },
        actions: [{ action: 'inspect' }]
      }) }
    }] } };
    return '{"candidate":"candidate-1","summary":"Added a search hint."}';
  }, {
    maxTokens: 32000, onAgentEvent: (event) => events.push(event),
    async testBrowser(candidate) {
      browserRuns++;
      assert.match(candidate['index.html'], /placeholder="Search"/);
      assert.equal(candidate['server.js'], files['server.js']);
      assert.ok(candidate['help.html']);
      return { status: 'passed' };
    }
  });
  assert.equal(truncations, 1);
  assert.equal(browserRuns, 1);
  assert.match(output.files['index.html'], /placeholder="Search"/);
  assert.ok(events.some((event) => event.detail === '正在用局部替换重试'));
});

test('analysis tasks execute ready work in parallel, honor dependency outputs, and replan after review', { timeout: 6500 }, async () => {
  const task = (id, dependsOn = []) => ({ id, title: id, capability: 'analyze', goal: id, acceptance: 'Provide evidence.', dependsOn });
  const both = Promise.withResolvers();
  const started = [];
  const events = [];
  let reviewed = 0;
  const result = await buildProject(model, 'Analyze this CSV: Jan,20; Feb,10.', undefined, async (_config, messages) => {
    const input = JSON.parse(messages[1].content);
    if (isPlan(messages[0])) return JSON.stringify({
      mode: 'tasks', tasks: [task('data-check'), task('calculate-change'), task('write-report', ['data-check', 'calculate-change'])]
    });
    if (messages[0].content.startsWith('You are the central agent reviewing completed tasks')) {
      reviewed++;
      if (reviewed === 1) {
        assert.equal(input.completed['write-report'].result, 'Need to specify units.');
        return JSON.stringify({ tasks: [task('confirm-units', ['data-check'])] });
      }
      assert.equal(input.completed['confirm-units'].result, 'Month over month, down 50%.');
      return '{"answer":"Sales fell from 20 to 10, down 50% month over month."}';
    }
    started.push(input.assignment);
    if (started.length === 2) both.resolve();
    if (['data-check', 'calculate-change'].includes(input.assignment)) await both.promise;
    if (input.assignment === 'data-check') return '{"result":"Two months, no missing values."}';
    if (input.assignment === 'calculate-change') return '{"result":"20 to 10, down 50%."}';
    if (input.assignment === 'write-report') {
      assert.deepEqual(Object.keys(input.dependencies), ['data-check', 'calculate-change']);
      return '{"result":"Need to specify units."}';
    }
    assert.deepEqual(Object.keys(input.dependencies), ['data-check']);
    return '{"result":"Month over month, down 50%."}';
  }, { maxTokens: 32000, onAgentEvent: (event) => events.push(event) });
  assert.deepEqual(new Set(started.slice(0, 2)), new Set(['data-check', 'calculate-change']));
  assert.deepEqual(started.slice(2), ['write-report', 'confirm-units']);
  assert.ok(events.some((event) => event.taskId === 'confirm-units' && event.round === 1));
  assert.deepEqual(result, { files: null, summary: 'Sales fell from 20 to 10, down 50% month over month.' });
});

test('invalid dependency cycles and write capabilities are rejected for read-only runs', async () => {
  for (const invalid of [{ capability: 'analyze', dependsOn: ['one'] }, { capability: 'frontend', dependsOn: [] }]) {
    await assert.rejects(buildProject(model, 'Analyze project inputs.', undefined, async (_config, messages) => {
      assert.ok(isPlan(messages[0]));
      return JSON.stringify({ mode: 'tasks', tasks: [{ id: 'one', title: 'One', goal: 'Review data', acceptance: 'Facts', ...invalid }] });
    }, { maxTokens: 32000 }), /重新规划后.*仍未通过校验/);
  }
});

test('a rejected continuation plan is corrected before any worker runs', async () => {
  let plans = 0;
  const events = [];
  const output = await buildProject(model, 'Continue', files, async (_config, messages) => {
    if (isPlan(messages[0])) {
      plans++;
      if (plans === 1) return JSON.stringify({
        mode: 'tasks', tasks: [{ id: 'edit', title: 'Edit', capability: 'frontend', goal: 'Change UI', acceptance: 'Shows search' }]
      });
      assert.match(messages[1].content, /rejectedPlan/);
      return JSON.stringify({ ...plan, backend: undefined });
    }
    assert.equal(plans, 2);
    if (messages.length === 2) return read('index.html');
    return JSON.stringify({ edits: [{ path: 'index.html', before: '>Go<', after: '>Search<' }] });
  }, {
    maxTokens: 32000, onAgentEvent: (event) => events.push(event),
    testBrowser: async () => ({ status: 'passed' })
  });
  assert.equal(plans, 2);
  assert.match(output.files['index.html'], />Search</);
  assert.ok(events.some((event) => event.detail === '正在修正任务依赖与执行能力'));
});

test('a new infinite-scroll gallery reaches direct browser verification after a rejected team plan', async () => {
  const galleryPlan = {
    mode: 'team', contract: 'Render cards in .photo and append another batch after scrolling.', tasks: [
      { id: 'gallery', title: '图片瀑布流', capability: 'frontend', goal: 'Build the gallery.', acceptance: 'New cards appear after scrolling.' },
      { id: 'verify', title: '滚动验收', capability: 'browser', goal: 'Scroll the gallery.', acceptance: 'Card count increases.', dependsOn: ['gallery'] }
    ]
  };
  const draft = { ...files, 'index.html': '<main class="gallery"><img class="photo" alt="图片"></main>' };
  const actions = [{ action: 'scroll' }, { action: 'assert_count', selector: '.photo', minCount: 13 }];
  for (const revised of [{ mode: 'direct' }, galleryPlan]) {
    let plans = 0;
    let browserRuns = 0;
    const events = [];
    const output = await buildProject(model, '做一个图片瀑布流效果 能无限滚动的', undefined, async (_config, messages) => {
      if (isPlan(messages[0])) {
        if (++plans === 1) return JSON.stringify(galleryPlan);
        assert.match(JSON.parse(messages[1].content).validationError, /index.html and server.js/);
        return JSON.stringify(revised);
      }
      assert.doesNotMatch(messages[0].content, /sub-agent/);
      if (messages.length === 2) return { message: { tool_calls: [{
        id: 'test-gallery', function: { name: 'test_preview', arguments: JSON.stringify({ files: draft, actions }) }
      }] } };
      return '{"candidate":"candidate-1","summary":"已生成图片瀑布流。"}';
    }, {
      maxTokens: 32000, onAgentEvent: (event) => events.push(event),
      async testBrowser(candidate, steps) {
        browserRuns++;
        assert.deepEqual({ ...candidate }, draft);
        assert.deepEqual(steps.map(({ action }) => action), ['scroll', 'assert_count']);
        assert.equal(steps[1].minCount, 13);
        return { status: 'passed', steps: steps.map(({ action }) => ({ action, ok: true })) };
      }
    });
    assert.equal(plans, 2);
    assert.equal(browserRuns, 1);
    assert.deepEqual({ ...output.files }, draft);
    assert.match(output.summary, /浏览器验证通过/);
    assert.ok(events.some((event) => event.role === 'direct' && event.state === 'done'));
    assert.ok(!events.some((event) => event.kind === 'assign'));
  }
});

test('website tasks can read their own project evidence before editing and running browser checks', async () => {
  const task = (id, capability, dependsOn = []) => ({ id, title: id, capability, goal: id, acceptance: 'Verify the search label.', dependsOn });
  let proposals = 0;
  let testRuns = 0;
  const result = await buildProject(model, 'Update the search label.', files, async (_config, messages) => {
    if (isPlan(messages[0])) return JSON.stringify({
      mode: 'team', contract: { search: plan.contract }, tasks: [
        task('find-label', 'read_project'), task('edit-label', 'frontend', ['find-label']),
        task('test-label', 'browser', ['edit-label'])
      ]
    });
    if (messages[0].content.startsWith('You are the browser acceptance agent')) {
      assert.match(messages[1].content, /Verify the search label/);
      assert.match(messages[1].content, /edit-label/);
      if (++proposals === 1) return JSON.stringify({ tests: [{ action: 'click' }, { action: 'assert_text', value: 'sample' }] });
      assert.match(JSON.parse(messages[1].content).feedback.error, /第 1 步的 selector/);
      return JSON.stringify({ tests: plan.tests });
    }
    if (messages[0].content.startsWith('Complete only the assigned task')) {
      if (messages.length === 2) return '{"read":["index.html"]}';
      assert.match(messages.at(-1).content, /id=\\"submit/);
      return '{"result":"Existing #submit text is Go."}';
    }
    assert.match(messages[1].content, /Existing #submit text is Go/);
    if (messages.length === 2) return read('index.html');
    return JSON.stringify({ edits: [{ path: 'index.html', before: '>Go<', after: '>Search<' }] });
  }, {
    maxTokens: 32000,
    async testBrowser(candidate, actions) {
      testRuns++;
      assert.match(candidate['index.html'], />Search</);
      assert.deepEqual(actions.map(({ action }) => action), testRuns === 1 ? ['inspect'] : ['fill', 'click', 'assert_text']);
      return { status: 'passed' };
    }
  });
  assert.match(result.summary, /通过浏览器验收/);
  assert.equal(proposals, 2);
  assert.equal(testRuns, 2);
  assert.equal(result.files['server.js'], files['server.js']);
});

for (const repeatError of [false, true]) {
test(repeatError ? 'identical browser failures honor the 20-round cap' : 'changing browser failures honor the 20-round cap', async () => {
  let browserRuns = 0;
  let repairs = 0;
  const changes = { ...files };
  await assert.rejects(buildProject(model, 'Build a full-stack site.', undefined, async (_config, messages, _tokens, options) => {
    if (isPlan(messages[0])) return JSON.stringify(plan);
    if (isRepair(messages[0])) {
      repairs++;
      return JSON.stringify({ backend: 'Fix the endpoint.' });
    }
    const role = roleOf(messages[0]);
    const file = role === 'frontend' ? 'index.html' : 'server.js';
    if (messages[1].content.includes('PROJECT FILE MANIFEST') && messages.length === 2) {
      return options.thinking ? read(file) : JSON.stringify({ read: [file] });
    }
    changes[file] += '\n';
    return JSON.stringify({ changes: { [file]: changes[file] } });
  }, {
    maxTokens: 32000,
    async testBrowser() { browserRuns++; return { status: 'failed', error: 'Assertion failed ' + (repeatError ? 1 : browserRuns) }; }
  }), repeatError ? /修复 20 轮后仍未通过验收.*\nAssertion failed 1/ : /修复 20 轮后仍未通过验收.*\nAssertion failed 21/);
  assert.equal(browserRuns, 21);
  assert.equal(repairs, 20);
});
}

test('failed acceptance planning reports the task name and the reasons from both attempts', async () => {
  let qaAttempts = 0;
  let browserRuns = 0;
  await assert.rejects(buildProject(model, 'Verify cart navigation.', files, async (_config, messages) => {
    if (isPlan(messages[0])) return JSON.stringify({
      mode: 'team', contract: plan.contract, tasks: [
        { id: 'edit', title: 'Update cart', capability: 'frontend', goal: 'Update cart', acceptance: 'Show cart' },
        { id: 'qa', title: '购物车流程', capability: 'browser', goal: 'Verify cart', acceptance: 'Show cart', dependsOn: ['edit'] }
      ]
    });
    if (messages[0].content.startsWith('You are the browser acceptance agent')) {
      if (++qaAttempts === 1) return '{"steps":[]}';
      return '{"tests":[{"action":"click","selector":"#cart"},{"action":"assert_visible","selector":"#note"}]}';
    }
    if (messages.length === 2) return read('index.html');
    return JSON.stringify({ edits: [{ path: 'index.html', before: '>Go<', after: '>Cart<' }] });
  }, {
    maxTokens: 32000,
    async testBrowser(_candidate, actions) {
      browserRuns++;
      assert.deepEqual(actions.map(({ action }) => action), ['inspect']);
      return { status: 'passed' };
    }
  }), (error) => {
    assert.match(error.message, /购物车流程.*步骤校验阶段/);
    assert.match(error.message, /第 1 次拟定.*没有 tests 字段.*steps/);
    assert.match(error.message, /第 2 次拟定.*第 2 步.*assert_visible/);
    return true;
  });
  assert.equal(browserRuns, 1);
});

test('an observed class used as a gallery text assertion is corrected without sending workers back', async () => {
  const tests = [{ action: 'assert_text', selector: '#masonry', value: 'card' }, { action: 'scroll' },
    { action: 'assert_count', selector: '.card', minCount: 13 }];
  let checks = 0;
  const result = await buildProject(model, 'Build a photo gallery.', undefined, async (_config, messages) => {
    if (isPlan(messages[0])) return JSON.stringify({ ...plan, tests });
    assert.ok(!isRepair(messages[0]));
    const file = roleOf(messages[0]) === 'frontend' ? 'index.html' : 'server.js';
    return JSON.stringify({ changes: { [file]: files[file] } });
  }, {
    maxTokens: 32000,
    async testBrowser(_candidate, steps) {
      if (++checks === 1) return { status: 'failed', steps: [{ ok: false, action: 'assert_text', classToken: 'card' }] };
      assert.deepEqual(steps[0], { action: 'assert_count', selector: ':is(#masonry) .card', minCount: 1 });
      assert.deepEqual(steps[2], tests[2]);
      return { status: 'passed' };
    }
  });
  assert.equal(checks, 2);
  assert.match(result.summary, /通过浏览器验收/);
});

test('the central agent can retrieve history and gives each worker only its own project decisions', async () => {
  const memory = {
    context: { summary: { requirements: ['Previously confirmed display rule'] }, recent: [{ reply: 'CENTRAL-ONLY-RAW' }] },
    searches: 0,
    get canSearch() { return this.searches < 3; },
    lookup(value) {
      this.searches++;
      assert.equal(value.query, 'confirmed detail');
      return '{"matches":[{"reply":"CENTRAL-ONLY-DETAIL"}]}';
    }
  };
  const output = await buildProject(model, 'Implement the requested full-stack feature.', undefined, async (_config, messages) => {
    if (isPlan(messages[0])) {
      assert.match(messages[1].content, /CENTRAL-ONLY-RAW/);
      if (messages.length === 2) return '{"history":{"query":"confirmed detail"}}';
      assert.match(messages.at(-1).content, /CENTRAL-ONLY-DETAIL/);
      return JSON.stringify({ ...plan, frontendContext: 'UI-OWN-CONSTRAINT', backendContext: 'API-OWN-CONSTRAINT' });
    }
    const role = roleOf(messages[0]);
    assert.ok(!messages[1].content.includes('CENTRAL-ONLY'));
    assert.match(messages[1].content, role === 'frontend' ? /UI-OWN-CONSTRAINT/ : /API-OWN-CONSTRAINT/);
    assert.doesNotMatch(messages[1].content, role === 'frontend' ? /API-OWN-CONSTRAINT/ : /UI-OWN-CONSTRAINT/);
    const path = role === 'frontend' ? 'index.html' : 'server.js';
    return JSON.stringify({ changes: { [path]: files[path] } });
  }, { memory, maxTokens: 32000, testBrowser: async () => ({ status: 'passed' }) });
  assert.equal(memory.searches, 1);
  assert.ok(output.files['server.js']);
});
