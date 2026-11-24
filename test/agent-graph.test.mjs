import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildProject } from '../server/agent-workflow.mjs';
import { mergeWorkerChanges } from '../server/generation.mjs';
import { ModelOutputLimitError, PublicError } from '../server/models.mjs';
import { readyTasks } from '../server/task-plan.mjs';

const config = { platform: true };
const files = {
  'index.html': '<button id="open">Open</button>',
  'server.js': 'function handle() { return {status: 200, body: []}; }'
};
const actions = [{ action: 'click', selector: '#open' }, { action: 'assert_text', value: 'Open' }];
const team = { mode: 'team', contract: 'Click #open to see Open.', tests: actions };
const makeTask = (id, capability, dependsOn = []) => ({
  id, title: id, capability, goal: id, acceptance: 'Check ' + id, dependsOn
});
const planning = 'You are the central planning agent';
const reading = 'Complete only the assigned task';
const synthesis = 'You are the central agent reviewing';
const diagnose = 'You are the central agent reviewing a real browser investigation';
const qa = 'You are the browser acceptance agent';
const repair = 'You are the central agent diagnosing';

function scenario(replies, options = {}) {
  const trace = [];
  const events = [];
  const graphCallbacks = [{
    handleChainStart(_chain, input, _runId, _parent, _tags, metadata, _runType, name) {
      if (name === metadata?.langgraph_node && name !== '__start__') {
        trace.push({ name, step: metadata.langgraph_step, input });
      }
    }
  }];
  const result = buildProject(config, 'Work on the project.', options.files, async (_config, messages, tokens, call) => {
    const reply = replies.find(([prefix]) => messages[0].content.includes(prefix));
    assert.ok(reply, 'Unexpected model call: ' + messages[0].content.slice(0, 80));
    const value = typeof reply[1] === 'function' ? await reply[1](messages, call, tokens) : reply[1];
    return typeof value === 'object' && !value?.message ? JSON.stringify(value) : value;
  }, {
    maxTokens: 32000, ...options, graphCallbacks,
    onAgentEvent: (event) => events.push(event)
  });
  return { result, trace, events };
}

function steps(trace) {
  const grouped = Map.groupBy(trace, ({ step }) => step);
  return [...grouped.values()].map((entries) => entries.map(({ name }) => name).sort().join('+'));
}

const context = (messages) => JSON.parse(messages[1].content);
const changed = (path, content) => ({ changes: { [path]: content } });
const frontend = 'You are the frontend sub-agent';
const backend = 'You are the backend sub-agent';
const generation = 'Build a self-contained website';
const readBeforeEdit = (path, operation) => (messages, call) => {
  if (messages.length !== 2) return operation(messages, call);
  // Repair workers use the JSON file-reading protocol, regular workers use a tool call.
  return call.thinking ? { message: { tool_calls: [{
    id: 'read-' + path, function: { name: 'read_files', arguments: JSON.stringify({ paths: [path] }) }
  }] } } : { read: [path] };
};

test('planning accepts an explicit direct replan and direct emits no file changes for a question', async () => {
  let plans = 0;
  const run = scenario([
    [planning, (messages) => {
      if (++plans === 1) return { ...team, tasks: [makeTask('ui', 'frontend')] };
      assert.match(context(messages).validationError, /both frontend and backend/);
      assert.equal(context(messages).rejectedPlan.tasks[0].id, 'ui');
      return { mode: 'direct' };
    }],
    [generation, { answer: 'The page contains a button.' }]
  ], { testBrowser() { assert.fail('A question should not open a browser'); } });
  assert.deepEqual(await run.result, { files: null, summary: 'The page contains a button.' });
  assert.deepEqual(steps(run.trace), ['orchestrate', 'direct']);
  assert.equal(plans, 2);
  assert.equal(run.events.some(({ kind }) => kind === 'assign'), false);
});

test('planning routes a team proposal to direct when the browser is disabled', async () => {
  const run = scenario([
    [planning, (messages) => {
      assert.equal(context(messages).browserAvailable, false);
      assert.equal(context(messages).rejectedPlan, undefined);
      return { ...team, frontend: 'Build UI', backend: 'Build API' };
    }],
    [generation, { files }]
  ]);
  assert.deepEqual({ ...(await run.result).files }, files);
  assert.deepEqual(steps(run.trace), ['orchestrate', 'direct']);
});

test('a required team route cannot downgrade on malformed plans or missing browser support', async (t) => {
  for (const [name, replies] of [
    ['direct twice', [{ mode: 'direct' }, { mode: 'direct' }]],
    ['empty and read-only', ['', { mode: 'tasks', tasks: [makeTask('analysis', 'analyze')] }]],
    ['browser unavailable', []]
  ]) {
    await t.test(name, async () => {
      let plans = 0;
      const run = scenario([[planning, () => {
        assert.ok(plans < replies.length, 'Unexpected planner call');
        return replies[plans++];
      }]], {
        teamRequired: true,
        testBrowser: replies.length ? () => assert.fail('No candidate should reach the browser') : undefined
      });
      await assert.rejects(run.result, {
        statusCode: replies.length ? 422 : 503,
        message: replies.length ? /仍未生成有效的协作计划/ : /验收工具暂不可用/
      });
      assert.equal(plans, replies.length);
      assert.deepEqual(steps(run.trace), ['orchestrate']);
      assert.equal(run.events.some(({ role }) => role === 'direct'), false);
    });
  }
});

test('invalid plan IDs and dependencies are never dispatched', async (t) => {
  const read = makeTask('read', 'analyze');
  for (const [name, tasks] of [
    ['duplicate ID', [read, { ...read }]],
    ['unknown dependency', [makeTask('read', 'analyze', ['missing'])]],
    ['cycle', [makeTask('a', 'analyze', ['b']), makeTask('b', 'analyze', ['a'])]],
    ['too many tasks', Array.from({ length: 9 }, (_, index) => makeTask('task-' + index, 'analyze'))],
    ['writer in a read-only plan', [makeTask('read', 'frontend')]]
  ]) {
    await t.test(name, async () => {
      let replans = 0;
      const run = scenario([[planning, (messages) => {
        if (context(messages).rejectedPlan) replans++;
        return { mode: 'tasks', tasks };
      }]]);
      await assert.rejects(run.result, { statusCode: 422, message: /重新规划后/ });
      assert.equal(replans, 1);
      assert.deepEqual(steps(run.trace), ['orchestrate']);
    });
  }
});

test('team planning rejects acceptance tasks that another task depends on', async () => {
  const run = scenario([
    [planning, (messages) => {
      if (context(messages).rejectedPlan) {
        assert.match(context(messages).validationError, /No other task may depend on it/);
        return { mode: 'direct' };
      }
      return { ...team, tasks: [makeTask('qa', 'browser'), makeTask('ui', 'frontend', ['qa'])] };
    }],
    [generation, { answer: 'Existing behavior confirmed.' }]
  ], { files, async testBrowser() { assert.fail('No candidate should have been created'); } });
  assert.equal((await run.result).summary, 'Existing behavior confirmed.');
  assert.deepEqual(steps(run.trace), ['orchestrate', 'direct']);
});

test('three ready tasks obey the concurrency limit and failed dependencies remain blocked', { timeout: 3000 }, async () => {
  const pair = Promise.withResolvers();
  let active = 0;
  let peak = 0;
  const called = [];
  const run = scenario([
    [planning, { mode: 'tasks', tasks: [
      makeTask('a', 'analyze'), makeTask('b', 'analyze'), makeTask('c', 'analyze'),
      makeTask('blocked', 'analyze', ['a']), makeTask('ready', 'analyze', ['b'])
    ] }],
    [reading, async (messages) => {
      const { assignment, dependencies } = context(messages);
      called.push(assignment);
      active++;
      peak = Math.max(peak, active);
      if (called.length === 2) pair.resolve();
      await pair.promise;
      active--;
      if (assignment === 'a') throw new PublicError(502, 'Read failed');
      if (assignment === 'ready') assert.deepEqual(dependencies, { b: 'Result b' });
      return { result: 'Result ' + assignment };
    }],
    [synthesis, (messages) => {
      const { blocked, completed } = context(messages);
      assert.deepEqual(blocked, [{ id: 'blocked', title: 'blocked', dependsOn: ['a'] }]);
      assert.deepEqual(completed.a, { ok: false, result: 'Read failed' });
      assert.deepEqual(completed.ready, { ok: true, result: 'Result ready' });
      return { answer: 'Partial results with the failed dependency disclosed.' };
    }]
  ]);
  assert.match((await run.result).summary, /failed dependency/);
  assert.equal(peak, 2);
  assert.deepEqual([...called].sort(), ['a', 'b', 'c', 'ready']);
  assert.deepEqual(steps(run.trace), ['orchestrate', 'schedule', 'worker+worker+worker', 'merge', 'schedule', 'worker', 'merge', 'synthesize']);
  assert.ok(run.events.some(({ taskId, state }) => taskId === 'blocked' && state === 'failed'));
  assert.deepEqual(readyTasks([makeTask('blocked', 'analyze', ['a'])], { a: { ok: false } }), []);
});

test('synthesis cannot dispatch duplicate tasks, failed dependencies, or a third follow-up', async (t) => {
  for (const kind of ['duplicate', 'failed dependency', 'round limit', 'total task limit']) {
    await t.test(kind, async () => {
      const taskCount = kind === 'total task limit' ? 8 : 1;
      let reviews = 0;
      const run = scenario([
        [planning, { mode: 'tasks', tasks: Array.from({ length: taskCount }, (_, i) => makeTask('read-' + i, 'analyze')) }],
        [reading, (messages) => {
          if (kind === 'failed dependency') throw new PublicError(422, 'No result');
          return { result: context(messages).assignment };
        }],
        [synthesis, (messages) => {
          reviews++;
          const { remainingTasks } = context(messages);
          if (kind === 'round limit' && reviews <= 2) {
            assert.equal(remainingTasks, 8 - reviews);
            return { tasks: [makeTask('follow-' + reviews, 'analyze')] };
          }
          if (kind.includes('limit')) assert.equal(remainingTasks, 0);
          const next = kind === 'duplicate' ? makeTask('read-0', 'analyze') :
            makeTask('next', 'analyze', kind === 'failed dependency' ? ['read-0'] : []);
          return { tasks: [next], answer: 'Final report.' };
        }]
      ]);
      assert.deepEqual(await run.result, { files: null, summary: 'Final report.' });
      assert.equal(reviews, kind === 'round limit' ? 3 : 1);
      const workers = run.trace.filter(({ name }) => name === 'worker');
      assert.equal(workers.length, kind === 'round limit' ? 3 : taskCount);
      assert.equal(new Set(workers.map(({ input }) => input.assignment.id)).size, workers.length);
      const path = steps(run.trace);
      assert.equal(path.at(-1), 'synthesize');
      assert.equal(path.filter((name, index) => name === 'synthesize' && path[index + 1] === 'schedule').length,
        kind === 'round limit' ? 2 : 0);
    });
  }
});

test('same-role writes are serialized and the second writer reads the merged first version', async () => {
  const first = '<button id="open">First</button>';
  const second = '<button id="open">Second</button>';
  const run = scenario([
    [planning, { ...team, tasks: [makeTask('first', 'frontend'), makeTask('second', 'frontend')] }],
    [frontend, readBeforeEdit('index.html', (messages) => {
      const source = JSON.parse(messages.at(-1).content).files[0].content;
      if (source === files['index.html']) return changed('index.html', first);
      assert.equal(source, first);
      return changed('index.html', second);
    })]
  ], { files, async testBrowser(candidate, received) {
    assert.equal(candidate['index.html'], second);
    assert.deepEqual(received.map(({ action }) => action), ['click', 'assert_text']);
    return { status: 'passed' };
  } });
  assert.deepEqual({ ...(await run.result).files }, { ...files, 'index.html': second });
  assert.deepEqual(steps(run.trace), ['orchestrate', 'schedule', 'worker', 'merge', 'schedule', 'worker', 'merge', 'verify']);
});

test('a team merge with no effective changes exits before browser acceptance', async () => {
  const run = scenario([
    [planning, { ...team, frontend: 'Check the current UI.' }],
    [frontend, readBeforeEdit('index.html', () => changed('index.html', files['index.html']))]
  ], { files, testBrowser() { assert.fail('Existing version did not change'); } });
  assert.deepEqual(await run.result, { files: null, summary: '本次没有修改项目文件。' });
  assert.deepEqual(steps(run.trace), ['orchestrate', 'schedule', 'worker', 'merge']);
});

test('conflicting patch inputs leave the candidate untouched', () => {
  const saved = { ...files };
  assert.throws(() => mergeWorkerChanges(files, [
    { 'index.html': '<h1>First worker</h1>' }, { 'index.html': '<h1>Second worker</h1>' }
  ]), { statusCode: 422, message: /冲突的文件改动/ });
  assert.deepEqual(files, saved);
});

test('an unsuccessful read-only dependency blocks team edits before any browser call', async () => {
  const run = scenario([
    [planning, { ...team, tasks: [makeTask('find', 'read_project'), makeTask('edit', 'frontend', ['find'])] }],
    [reading, '{"result":""}']
  ], { files, testBrowser() { assert.fail('Blocked edits must not open the browser'); } });
  await assert.rejects(run.result, { statusCode: 422, message: /依赖的结果未完成/ });
  assert.deepEqual(steps(run.trace), ['orchestrate', 'schedule', 'worker', 'merge']);
  assert.equal(run.events.some(({ taskId, state }) => taskId === 'edit' && state === 'running'), false);
});

test('a missing entry file is repaired before the browser receives the candidate', async () => {
  const after = '<h1>Restored entry file</h1>';
  const run = scenario([
    [planning, { ...team, frontend: 'Rebuild the page.' }],
    [frontend, (messages, call) => call.thinking ?
      readBeforeEdit('index.html', () => changed('index.html', null))(messages, call) :
      changed('index.html', after)],
    [repair, (messages) => {
      assert.deepEqual(context(messages).eligibleRoles, ['frontend']);
      assert.equal(context(messages).failure.error, 'Required entry file missing.');
      return { frontend: 'Restore index.html.' };
    }]
  ], { files, async testBrowser(candidate) {
    assert.deepEqual({ ...candidate }, { ...files, 'index.html': after });
    return { status: 'passed' };
  } });
  assert.equal((await run.result).files['index.html'], after);
  assert.deepEqual(steps(run.trace), ['orchestrate', 'schedule', 'worker', 'merge', 'repair', 'worker', 'merge', 'verify']);
});

test('every failed worker is repaired before merge can verify an existing project', async () => {
  const after = { 'index.html': '<h1>New UI</h1>', 'server.js': 'function handle() { return {status:200,body:[1]}; }' };
  const run = scenario([
    [planning, { ...team, tasks: [makeTask('ui', 'frontend'), makeTask('api', 'backend')] }],
    [frontend, (messages, call) => readBeforeEdit('index.html', () =>
      changed(call.thinking ? 'server.js' : 'index.html', call.thinking ? after['server.js'] : after['index.html']))(messages, call)],
    [backend, (messages, call) => {
      if (call.thinking) throw new PublicError(502, 'Backend worker timed out');
      return readBeforeEdit('server.js', () => changed('server.js', after['server.js']))(messages, call);
    }],
    [repair, (messages) => {
      const failure = context(messages).failure;
      assert.deepEqual(failure.workerErrors.map(({ id }) => id).sort(), ['api', 'ui']);
      assert.match(failure.workerErrors.find(({ id }) => id === 'ui').error, /分工范围之外/);
      assert.equal(failure.workerErrors.find(({ id }) => id === 'api').error, 'Backend worker timed out');
      return { frontend: 'Complete the UI.' };
    }]
  ], { files, async testBrowser(candidate) {
    assert.deepEqual({ ...candidate }, after);
    return { status: 'passed' };
  } });
  assert.deepEqual({ ...(await run.result).files }, after);
  assert.deepEqual(steps(run.trace), ['orchestrate', 'schedule', 'worker+worker', 'merge', 'repair', 'worker+worker', 'merge', 'verify']);
});

test('browser inspection failure goes through repair, then inspects and tests the repaired version', async () => {
  const api = 'function handle() { return {status:200,body:["ok"]}; }';
  const inspected = [];
  const run = scenario([
    [planning, { ...team, tasks: [
      makeTask('ui', 'frontend'), makeTask('api', 'backend'), makeTask('qa', 'browser', ['ui', 'api'])
    ] }],
    [frontend, changed('index.html', files['index.html'])],
    [backend, (messages, call) => messages[1].content.includes('PROJECT FILE MANIFEST') ?
      readBeforeEdit('server.js', () => changed('server.js', api))(messages, call) : changed('server.js', files['server.js'])],
    [repair, (messages) => {
      assert.deepEqual(context(messages).eligibleRoles, ['backend']);
      assert.match(context(messages).failure.error, /Cannot start candidate backend/);
      return {};
    }],
    [qa, (messages) => {
      assert.equal(context(messages).dom, 'repaired DOM');
      assert.deepEqual(Object.keys(context(messages).dependencies).sort(), ['api', 'ui']);
      return { tests: actions };
    }]
  ], { async testBrowser(candidate, received) {
    inspected.push([candidate['server.js'], received[0].action]);
    if (inspected.length === 1) return { status: 'failed', error: 'Cannot start candidate backend: invalid setup' };
    return { status: 'passed', dom: 'repaired DOM' };
  } });
  assert.deepEqual({ ...(await run.result).files }, { ...files, 'server.js': api });
  assert.deepEqual(inspected, [[files['server.js'], 'inspect'], [api, 'inspect'], [api, 'click']]);
  assert.deepEqual(steps(run.trace), ['orchestrate', 'schedule', 'worker+worker', 'merge', 'qa', 'repair', 'worker', 'merge', 'qa', 'verify']);
  const fix = run.trace.filter(({ name }) => name === 'worker').at(-1).input;
  assert.equal(fix.assignment.id, 'api');
  assert.match(fix.assignment.task, /invalid setup/);
});

test('qa falls back to the validated plan steps after two invalid proposals', async () => {
  let proposals = 0;
  const seen = [];
  const run = scenario([
    [planning, { ...team, frontend: 'Change the page.', qa: 'Review the Open action.' }],
    [frontend, readBeforeEdit('index.html', () => changed('index.html', '<button id="open">Open details</button>'))],
    [qa, (messages) => {
      proposals++;
      if (proposals === 1) return { tests: [{ action: 'inspect' }] };
      assert.match(context(messages).feedback.error, /缺少 assert_text 或 assert_count/);
      return 'bad JSON';
    }]
  ], { files, async testBrowser(_candidate, received) {
    seen.push(JSON.parse(JSON.stringify(received)));
    return { status: 'passed', dom: 'Open details' };
  } });
  assert.ok((await run.result).files);
  assert.deepEqual(seen, [[{ action: 'inspect' }], actions]);
  assert.deepEqual(steps(run.trace), ['orchestrate', 'schedule', 'worker', 'merge', 'qa', 'verify']);
  assert.equal(proposals, 2);
});

test('verify preserves its interaction and assertion when a failed candidate comes back from repair', async () => {
  const broken = '<button id="open">Nothing happens</button>';
  const repaired = '<button id="open">Open</button><p>Opened details</p>';
  const verification = [{ action: 'click', selector: '#open' }, { action: 'assert_text', value: 'Opened details' }];
  const failedCheck = { status: 'failed', dom: 'Nothing happens', steps: [
    { action: 'click', ok: true },
    { action: 'assert_text', ok: false, error: 'Details never appeared' }
  ] };
  const candidates = [];
  const run = scenario([
    [planning, { ...team, frontend: 'Open the details on click.', qa: 'Test details.' }],
    [frontend, readBeforeEdit('index.html', (_messages, { thinking }) =>
      changed('index.html', thinking ? broken : repaired))],
    [qa, { tests: verification }],
    [repair, (messages) => {
      const request = context(messages);
      assert.deepEqual(request.tests, verification);
      assert.equal(request.failure.steps[1].error, 'Details never appeared');
      assert.deepEqual(request.failure.failedStep, { number: 2, ...verification[1] });
      assert.match(messages[0].content, /response.json\(\) returns body itself/);
      return { frontend: 'Render details when Open is clicked.' };
    }]
  ], { files, async testBrowser(candidate, received) {
    if (received[0].action === 'inspect') return { status: 'passed' };
    candidates.push(candidate['index.html']);
    assert.deepEqual(JSON.parse(JSON.stringify(received)), verification);
    return candidates.length === 1 ? failedCheck : { status: 'passed' };
  } });
  assert.equal((await run.result).files['index.html'], repaired);
  assert.deepEqual(candidates, [broken, repaired]);
  assert.deepEqual(steps(run.trace), ['orchestrate', 'schedule', 'worker', 'merge', 'qa', 'verify', 'repair', 'worker', 'merge', 'verify']);
  const checks = run.events.filter(({ kind }) => kind === 'check');
  assert.deepEqual(checks.map(({ state, round }) => [state, round]), [['failed', 0], ['done', 1]]);
  assert.equal(checks[0].step, 2);
  assert.equal(checks[0].expected, 'Opened details');
});

test('verification review may correct a selector but cannot drop the post-scroll assertion', async (t) => {
  const checks = [{ action: 'scroll', selector: '#list' }, { action: 'assert_count', selector: '.wrong-card', minCount: 24 }];
  const revised = [{ action: 'scroll', selector: '#list' }, { action: 'assert_count', selector: '.photo', minCount: 24 }];
  for (const preserve of [true, false]) {
    await t.test(preserve ? 'corrected selector passes' : 'missing post-scroll check is rejected', async () => {
      let writes = 0;
      let reviews = 0;
      let checksRun = 0;
      const run = scenario([
        [planning, { ...team, frontend: 'Improve gallery scrolling.', qa: 'Verify that scrolling loads more images.' }],
        [frontend, readBeforeEdit('index.html', () => changed('index.html', '<p>Gallery version ' + ++writes + '</p>'))],
        [qa, (messages) => {
          if (!messages[0].content.includes('Review the repeated failure')) return { tests: checks };
          reviews++;
          const { currentTests, failure } = context(messages);
          assert.deepEqual(currentTests, checks);
          assert.equal(failure.steps[1].error, 'Wrong card selector');
          return { tests: preserve ? revised : [...actions, revised[0]] };
        }],
        [repair, { frontend: 'Fix the card markup.' }]
      ], { files, async testBrowser(_candidate, received) {
        if (received[0].action === 'inspect') return { status: 'passed' };
        checksRun++;
        if (preserve && checksRun === 3) {
          assert.deepEqual(JSON.parse(JSON.stringify(received)), revised);
          return { status: 'passed' };
        }
        assert.deepEqual(JSON.parse(JSON.stringify(received)), checks);
        return { status: 'failed', steps: [{ action: 'scroll', ok: true },
          { action: 'assert_count', ok: false, error: 'Wrong card selector' }] };
      } });
      if (preserve) {
        const output = await run.result;
        assert.match(output.summary, /验收步骤复核后/);
        assert.equal(output.files['index.html'], '<p>Gallery version 2</p>');
      } else {
        await assert.rejects(run.result, {
          statusCode: 422, message: /连续 3 次遇到同一错误[\s\S]*第 2 步[\s\S]*\.wrong-card[\s\S]*24/
        });
      }
      assert.equal(reviews, 1);
      assert.equal(checksRun, 3);
      assert.equal(writes, preserve ? 2 : 3);
    });
  }
});

test('browser unavailable stops at either qa or verify with a 503 and no repair', async (t) => {
  for (const useQa of [true, false]) {
    await t.test(useQa ? 'qa' : 'verify', async () => {
      const run = scenario([
        [planning, { ...team, frontend: 'Improve button', qa: useQa ? 'Design tests' : undefined }],
        [frontend, readBeforeEdit('index.html', () => changed('index.html', '<button id="open">Open now</button>'))]
      ], { files, testBrowser: async () => ({ status: 'unavailable' }) });
      await assert.rejects(run.result, { statusCode: 503, message: /浏览器测试暂不可用/ });
      assert.deepEqual(steps(run.trace), ['orchestrate', 'schedule', 'worker', 'merge', useQa ? 'qa' : 'verify']);
    });
  }
});

test('direct rejects malformed output before browser testing or reporting success', async () => {
  const run = scenario([[planning, { mode: 'direct' }], [generation, '{"files":']], {
    testBrowser() { assert.fail('Malformed output must not open a browser'); }
  });
  await assert.rejects(run.result, { statusCode: 422, message: /输出格式无效/ });
  assert.deepEqual(steps(run.trace), ['orchestrate', 'direct']);
  assert.equal(run.events.some(({ role, state }) => role === 'direct' && state === 'done'), false);
});

test('direct generation truncation stops after the compact retry also reaches its limit', async () => {
  const attempts = [];
  const run = scenario([
    [planning, { mode: 'direct' }],
    [generation, (_messages, call) => {
      attempts.push(call.thinking);
      throw new ModelOutputLimitError();
    }]
  ]);
  await assert.rejects(run.result, ModelOutputLimitError);
  assert.deepEqual(attempts, [true, false]);
  assert.deepEqual(steps(run.trace), ['orchestrate', 'direct']);
});

test('workflow deadline stops a late browser pass before the graph can produce an output', async (t) => {
  const controller = new AbortController();
  const original = AbortSignal.timeout.bind(AbortSignal);
  const deadline = t.mock.method(AbortSignal, 'timeout', (milliseconds) =>
    milliseconds === 16 * 60 * 1000 ? controller.signal : original(milliseconds));
  const expired = new DOMException('Workflow deadline fixture', 'TimeoutError');
  const run = scenario([
    [planning, { ...team, frontend: 'Open the button' }],
    [frontend, readBeforeEdit('index.html', () => changed('index.html', '<button id="open">Open again</button>'))]
  ], { files, async testBrowser(_candidate, _actions, signal) {
    assert.equal(signal, controller.signal);
    controller.abort(expired);
    return { status: 'passed' };
  } });
  await assert.rejects(run.result, /deadline fixture|abort/i);
  assert.ok(deadline.mock.calls.some(({ arguments: args }) => args[0] === 16 * 60 * 1000));
  assert.deepEqual(steps(run.trace), ['orchestrate', 'schedule', 'worker', 'merge', 'verify']);
  assert.equal(run.events.some(({ kind, state }) => kind === 'check' && state === 'done'), false);
});

const herbGoal = '药材管理新增、列表、修改';
const herbAudit = { mode: 'investigate', goal: herbGoal, allowRepair: false };
const herbActions = [
  { action: 'click', selector: 'nav [data-view="herbs"]' },
  { action: 'click', selector: '#btn-add-herb' },
  { action: 'fill', selector: '#form-herb [name="name"]', value: '测试当归' },
  { action: 'fill', selector: '#form-herb [name="stock"]', value: '100' },
  { action: 'fill', selector: '#form-herb [name="retailPrice"]', value: '12.50' },
  { action: 'click', selector: '#form-herb button[type="submit"]' },
  { action: 'assert_text', selector: '#herb-table', value: '测试当归' },
  { action: 'assert_text', selector: '#herb-table', value: '12.50' },
  { action: 'click', selector: '#herb-table .herb-row button' },
  { action: 'assert_text', value: '编辑药材' },
  { action: 'fill', selector: '#form-herb [name="name"]', value: '编辑后的当归' },
  { action: 'click', selector: '#form-herb button[type="submit"]' },
  { action: 'assert_text', selector: '#herb-table', value: '编辑后的当归' }
];
const emptyListFailure = {
  status: 'failed', dom: '药材已新增；表格空白',
  api: [
    { method: 'POST', path: '/api/herbs', status: 200, response: { type: 'object', keys: ['id', 'name'] } },
    { method: 'GET', path: '/api/herbs', status: 200, response: { type: 'array', length: 1 } }
  ],
  steps: herbActions.slice(0, 7).map(({ action }, index) => ({
    action, ok: index < 6, ...(index === 6 && { error: 'Missing new row' })
  }))
};
const jsonActions = (actions) => JSON.parse(JSON.stringify(actions));

test('an existing CRUD audit runs the linked browser journey on the baseline and finishes without writes', async () => {
  let checks = 0;
  const run = scenario([
    [planning, herbAudit],
    [qa, (messages) => {
      assert.match(messages[0].content, /up to 20 browser actions/);
      const input = context(messages);
      assert.equal(input.dom, 'Existing project controls');
      if (!input.source) {
        assert.ok(input.files.includes('index.html'));
        return { read: ['index.html'] };
      }
      assert.deepEqual(input.source, { 'index.html': files['index.html'] });
      assert.doesNotMatch(messages[0].content, /first return \{"read"/);
      return { tests: herbActions };
    }]
  ], { files, teamRequired: true, onCandidate() { assert.fail('Baseline audit must not publish a candidate'); },
    async testBrowser(candidate, actions) {
      assert.deepEqual(candidate, files);
      assert.deepEqual(jsonActions(actions), ++checks === 1 ? [{ action: 'inspect' }] : herbActions);
      return { status: 'passed', dom: 'Existing project controls' };
    }
  });
  const result = await run.result;
  assert.equal(result.files, null);
  assert.match(result.summary, /当前版本通过浏览器验收[\s\S]*可见「测试当归」[\s\S]*可见「编辑后的当归」/);
  assert.deepEqual(steps(run.trace), ['orchestrate', 'qa', 'verify']);
  assert.equal(checks, 2);
});

test('browser reproduction can schedule fresh probes and source reads before dynamically assigning a fix', async () => {
  const patched = '<button id="open">Repaired decoder</button>';
  const publications = [];
  let decisions = 0;
  let browserRuns = 0;
  const run = scenario([
    [planning, { ...herbAudit, allowRepair: true }],
    [qa, { tests: herbActions }],
    [diagnose, (messages) => {
      const input = context(messages);
      assert.deepEqual(input.verification, herbActions);
      assert.equal(input.baselineFailure.failedStep.number, 7);
      assert.equal(input.baselineFailure.failedStep.value, '测试当归');
      assert.deepEqual(input.baselineFailure.api, emptyListFailure.api);
      assert.equal(input.repairAllowed, true);
      if (++decisions === 1) {
        assert.equal(browserRuns, 2);
        return { decision: 'probe', tests: [{ action: 'inspect', selector: '#herb-table' }] };
      }
      assert.equal(input.probes[0].dom, 'Empty list after save');
      if (decisions === 2) return { decision: 'investigate', tasks: [makeTask('decoder', 'read_project')] };
      assert.deepEqual(input.completed.decoder, { ok: true, result: 'Frontend reads an extra data.body.' });
      return { decision: 'repair', frontend: 'Decode the response body directly.' };
    }],
    [reading, (messages) => {
      assert.equal(context(messages).failureEvidence.failedStep.number, 7);
      if (messages.length === 2) return { read: ['index.html'] };
      assert.match(messages.at(-1).content, /<button/);
      return { result: 'Frontend reads an extra data.body.' };
    }],
    [frontend, readBeforeEdit('index.html', (messages) => {
      assert.equal(browserRuns, 3, 'A repair worker should start only after reproduction and evidence collection');
      assert.match(messages[1].content, /Frontend reads an extra data.body/);
      assert.match(messages[1].content, /"type":"array","length":1/);
      return changed('index.html', patched);
    })]
  ], { files, onCandidate(candidate) { publications.push(candidate['index.html']); },
    async testBrowser(candidate, actions) {
      browserRuns++;
      if (browserRuns === 1) return { status: 'passed' };
      if (browserRuns === 2) {
        assert.equal(candidate['index.html'], files['index.html']);
        assert.deepEqual(jsonActions(actions), herbActions);
        return emptyListFailure;
      }
      if (browserRuns === 3) {
        assert.equal(candidate['index.html'], files['index.html']);
        assert.deepEqual(jsonActions(actions), [{ action: 'inspect', selector: '#herb-table' }]);
        return { status: 'passed', dom: 'Empty list after save' };
      }
      assert.equal(candidate['index.html'], patched);
      assert.deepEqual(jsonActions(actions), herbActions);
      return { status: 'passed' };
    }
  });
  const output = await run.result;
  assert.equal(output.files['index.html'], patched);
  assert.equal(decisions, 3);
  assert.deepEqual(publications, [patched]);
  assert.deepEqual(steps(run.trace), [
    'orchestrate', 'qa', 'verify', 'diagnose', 'probe', 'diagnose', 'schedule', 'worker', 'merge',
    'diagnose', 'repair', 'worker', 'merge', 'verify'
  ]);
  const tasks = run.events.filter(({ kind }) => kind === 'assign');
  assert.deepEqual(tasks.map(({ role }) => role), ['browser', 'read_project', 'frontend']);
  assert.equal(tasks.at(-1).taskId, 'repair:1:frontend');
});

test('a verification-only failure cannot dispatch an editing task even when diagnosis proposes a repair', async () => {
  const run = scenario([
    [planning, herbAudit],
    [qa, { tests: herbActions }],
    [diagnose, (messages) => {
      assert.equal(context(messages).repairAllowed, false);
      return { decision: 'repair', frontend: 'Do an unauthorized edit.' };
    }]
  ], { files, onCandidate() { assert.fail('Test-only operation cannot publish edits'); },
    testBrowser: async (_candidate, actions) => actions[0].action === 'inspect' ? { status: 'passed' } : emptyListFailure
  });
  const result = await run.result;
  assert.equal(result.files, null);
  assert.match(result.summary, /第 7 步.*测试当归[\s\S]*本轮未发布改动/);
  assert.deepEqual(steps(run.trace), ['orchestrate', 'qa', 'verify', 'diagnose']);
});

test('successful probes neither clear the reproduction failure nor extend the investigation budget', async () => {
  let probes = 0;
  let decisions = 0;
  const run = scenario([
    [planning, herbAudit],
    [qa, { tests: herbActions }],
    [diagnose, (messages) => {
      const input = context(messages);
      assert.equal(input.probes.length, decisions);
      assert.equal(input.canProbe, decisions++ < 2);
      assert.equal(input.failure.failedStep.value, '测试当归');
      return { decision: 'probe', tests: [{ action: 'inspect', selector: '#herb-table' }] };
    }]
  ], { files, onCandidate() { assert.fail('A probe cannot publish the baseline'); },
    testBrowser: async (_candidate, actions) => {
      if (actions[0].action !== 'inspect') return emptyListFailure;
      if (actions[0].selector) probes++;
      return { status: 'passed' };
    }
  });
  const output = await run.result;
  assert.equal(output.files, null);
  assert.match(output.summary, /浏览器复现未通过/);
  assert.equal(probes, 2);
  assert.equal(decisions, 3);
  assert.deepEqual(steps(run.trace), ['orchestrate', 'qa', 'verify', 'diagnose', 'probe', 'diagnose', 'probe', 'diagnose']);
});

test('the graph can repair the test script against the baseline without weakening its CRUD assertions', async (t) => {
  for (const keepEditAssertion of [true, false]) {
    await t.test(keepEditAssertion ? 'complete test reruns' : 'weakened test is rejected', async () => {
      const initial = herbActions.map((step, i) => i === 2 ? { ...step, selector: 'input[name="name"]' } : step);
      const corrected = [{ action: 'inspect', selector: '#herb-table' }, ...herbActions];
      if (!keepEditAssertion) corrected.pop();
      let checks = 0;
      const run = scenario([
        [planning, herbAudit],
        [qa, { tests: initial }],
        [diagnose, (messages) => {
          const input = context(messages);
          assert.equal(input.canCorrectTests, true);
          assert.equal(input.failure.failedStep.selector, 'input[name="name"]');
          return { decision: 'correct_tests', tests: corrected };
        }]
      ], { files, onCandidate() { assert.fail('Test correction cannot publish a candidate'); },
        async testBrowser(candidate, actions) {
          assert.equal(candidate, files);
          checks++;
          if (checks === 1) return { status: 'passed' };
          if (checks === 2) return { status: 'failed', steps: [
            { action: 'click', ok: true }, { action: 'click', ok: true },
            { action: 'fill', ok: false, error: 'Strict mode: multiple matching form fields' }
          ] };
          assert.deepEqual(jsonActions(actions), corrected);
          return { status: 'passed' };
        }
      });
      const output = await run.result;
      assert.equal(output.files, null);
      assert.equal(checks, keepEditAssertion ? 3 : 2);
      assert.equal(steps(run.trace).at(-1), keepEditAssertion ? 'verify' : 'diagnose');
      assert.match(output.summary, keepEditAssertion ? /当前版本通过/ : /浏览器复现未通过/);
    });
  }
});

test('an edit-only click is not accepted as verification without a final visible assertion', async () => {
  let proposals = 0;
  let runs = 0;
  const run = scenario([
    [planning, herbAudit],
    [qa, (messages) => {
      if (++proposals === 1) return { tests: herbActions.slice(0, -1) };
      assert.match(context(messages).feedback.error, /最后一次交互后必须有可见结果/);
      return { tests: [...Array(8).fill({ action: 'inspect' }), ...herbActions] };
    }]
  ], { files, async testBrowser(_candidate, actions) {
    if (++runs === 2) assert.deepEqual(jsonActions(actions), herbActions);
    return { status: 'passed' };
  } });
  assert.match((await run.result).summary, /可见「编辑后的当归」/);
  assert.equal(proposals, 2);
  assert.equal(runs, 2);
});
