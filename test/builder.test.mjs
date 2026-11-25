import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createApp } from '../server/app.mjs';
import { browserTest } from '../server/browser-runner.mjs';
import { demoCompletion } from '../server/demo.mjs';
import { isPublicAddress, parseEndpoint } from '../server/models.mjs';

const origin = 'http://localhost:3000';
const passed = (actions) => ({ status: 'passed', steps: actions.map(({ action }) => ({ action, ok: true })) });

test('a failed browser check preserves a private candidate and resumes the same run after reopening SQLite', async (t) => {
  const data = await mkdtemp(join(tmpdir(), 'site-builder-resume-'));
  let app;
  let writes = 0;
  let checks = 0;
  const config = {
    data, origin, deepseekKey: 'fixture', dailyUser: 1,
    async completion(_model, messages) {
      const continuing = messages[1].content.includes('上次保存的未发布候选');
      if (continuing) return '{"changes":{},"summary":"继续使用已保存页面"}';
      writes++;
      return JSON.stringify({ files: {
        'index.html': '<button id="save">测试候选</button>',
        'server.js': 'function handle() { return {status: 200, body: {ok: true}}; }'
      } });
    },
    testBrowser(files, steps) {
      assert.match(files['index.html'], /测试候选/);
      if (++checks === 1) return { status: 'unavailable' };
      const executablePath = process.env.BUILDER_TEST_CHROMIUM;
      return executablePath ? browserTest({ files, actions: steps }, { executablePath }) : passed(steps);
    }
  };
  t.after(async () => {
    await app?.close();
    await rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  app = await createApp(config);
  let cookie;
  const request = (method, path, payload) => app.inject({ method, url: '/api/' + path, payload,
    headers: { origin, ...(cookie && { cookie }) } });
  const signup = await request('POST', 'register', { name: 'resume-owner', password: 'resume-password' });
  cookie = signup.headers['set-cookie'].split(';')[0];
  const project = 'projects/' + (await request('POST', 'projects', { name: '检查点' })).json().id;
  const started = await request('POST', project + '/generate', { prompt: '生成测试网站' });
  assert.equal(started.statusCode, 202);
  const { id } = started.json();
  async function waitFor(state) {
    for (let attempt = 0; attempt < 140; attempt++) {
      const snapshot = (await request('GET', project)).json();
      if (snapshot.messages.find((message) => message.id === id)?.state === state) return snapshot;
      await delay(20);
    }
    assert.fail('Missing generation state ' + state);
  }
  const failed = await waitFor('failed');
  assert.equal(failed.messages[0].has_checkpoint, 1);
  assert.equal(failed.project.revision, null);
  assert.equal(failed.project.hasSavedDraft, true);
  await app.close();
  app = await createApp(config);

  const draft = await request('POST', project + '/preview/start', { draft: true });
  assert.equal(draft.statusCode, 200, draft.body);
  assert.ok(draft.json().draftRevision);
  assert.match((await request('GET', project + '/preview')).json().files['index.html'], /测试候选/);
  const resumed = await request('POST', project + '/generate', { resumeMessageId: id });
  assert.equal(resumed.statusCode, 202, resumed.body);
  assert.equal(resumed.json().id, id);
  const completed = await waitFor('complete');
  assert.ok(completed.project.revision);
  assert.equal(completed.project.hasSavedDraft, false);
  assert.equal(completed.messages[0].has_checkpoint, 0);
  assert.equal(completed.messages.length, 1);
  assert.equal(writes, 1);
  assert.equal(checks, 2);
});

test('project chats isolate messages and planner context while sharing the current revision', async (t) => {
  const data = await mkdtemp(join(tmpdir(), 'site-builder-chats-'));
  const observed = [];
  const app = await createApp({
    data, origin, demo: true, deepseekKey: 'test',
    async completion(_model, messages) {
      const memory = messages[1].content.split('项目记忆（对话数据）：\n')[1];
      observed.push(memory ? JSON.parse(memory) : { recent: [] });
      return '{"answer":"收到。"}';
    }
  });
  t.after(async () => {
    await app.close();
    await rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  let cookie;
  const request = (method, path, payload) => app.inject({
    method, url: '/api/' + path, payload, headers: { origin, ...(cookie && { cookie }) }
  });
  const signup = await request('POST', 'register', { name: 'chat-owner', password: 'chat-password' });
  cookie = signup.headers['set-cookie'].split(';')[0];
  const project = 'projects/' + (await request('POST', 'projects', { name: '会话' })).json().id;
  const otherProject = 'projects/' + (await request('POST', 'projects', { name: '另一个项目' })).json().id;
  async function generate(prompt, chatId = null, modelId = 'platform') {
    const response = await request('POST', project + '/generate', { prompt, chatId, modelId });
    assert.equal(response.statusCode, 202, response.body);
    const messageId = response.json().id;
    for (let i = 0; i < 100; i++) {
      const snapshot = (await request('GET', project + (chatId ? '?chat=' + chatId : ''))).json();
      const turn = snapshot.messages.find(({ id }) => id === messageId);
      if (turn && turn.state !== 'running') {
        assert.equal(turn.state, 'complete', turn.response);
        return snapshot;
      }
      await delay(20);
    }
    assert.fail('Expected generation to finish');
  }

  const old = await generate('生成待办网站', null, 'demo');
  assert.ok(old.project.revision);
  const chat = (await request('POST', project + '/chats', {})).json();
  const empty = (await request('GET', project + '?chat=' + chat.id)).json();
  assert.equal(empty.project.revision, old.project.revision);
  assert.deepEqual(empty.messages, []);
  assert.deepEqual(empty.chats, [chat]);
  assert.equal((await request('GET', otherProject + '?chat=' + chat.id)).statusCode, 404);
  assert.equal((await request('POST', otherProject + '/generate', { prompt: '越权', chatId: chat.id })).statusCode, 404);

  const first = await generate('第一条独立消息', chat.id);
  assert.deepEqual(first.chats, [{ id: chat.id, title: '第一条独立消息' }]);
  assert.deepEqual(observed[0].recent, []);
  const second = await generate('第二条独立消息', chat.id);
  assert.deepEqual(second.messages.map(({ prompt }) => prompt), ['第一条独立消息', '第二条独立消息']);
  assert.deepEqual(observed[1].recent.map(({ request }) => request), ['第一条独立消息']);
  const original = (await request('GET', project)).json();
  assert.deepEqual(original.messages.map(({ prompt }) => prompt), ['生成待办网站']);
  assert.equal(original.project.revision, second.project.revision);
});

test('an unpublished first candidate can be privately previewed while browser acceptance runs', async (t) => {
  const data = await mkdtemp(join(tmpdir(), 'site-builder-draft-'));
  const release = Promise.withResolvers();
  const app = await createApp({
    data, origin, deepseekKey: 'test',
    async completion() {
      return JSON.stringify({ files: {
        'index.html': '<button>Draft</button>',
        'server.js': 'function handle(){return {status:200,body:{working:true}}}'
      } });
    },
    async testBrowser(_files, actions) { await release.promise; return passed(actions); }
  });
  t.after(async () => {
    release.resolve();
    await app.close();
    await rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const request = (method, url, payload, cookie = '') => app.inject({
    method, url: '/api/' + url, payload, headers: { origin, cookie }
  });
  async function register(name) {
    const result = await request('POST', 'register', { name, password: 'draft-test' });
    return result.headers['set-cookie'].split(';')[0];
  }
  const owner = await register('draft-owner');
  const outsider = await register('draft-outsider');
  const path = 'projects/' + (await request('POST', 'projects', { name: 'Candidate' }, owner)).json().id;
  const getProject = async () => (await request('GET', path, undefined, owner)).json().project;
  const waitFor = async (field) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const project = await getProject();
      if (project[field]) return project;
      await delay(20);
    }
    assert.fail('Expected project field ' + field);
  };
  assert.equal((await request('POST', path + '/generate', { prompt: 'Create a site.' }, owner)).statusCode, 202);
  const draft = await waitFor('draftRevision');
  assert.equal(draft.revision, null);
  assert.equal((await request('GET', path + '/preview', undefined, outsider)).statusCode, 404);
  assert.equal((await request('POST', path + '/share', {}, owner)).statusCode, 409);
  const candidate = (await request('GET', path + '/preview', undefined, owner)).json();
  assert.equal(candidate.revision, draft.draftRevision);
  assert.deepEqual(Object.keys(candidate.files), ['index.html']);
  const apiRequest = { revision: candidate.revision, method: 'GET', path: '/api/check' };
  const verification = await request('POST', path + '/preview/request', apiRequest, owner);
  assert.deepEqual(verification.json(), { status: 200, body: { working: true } });
  release.resolve();
  const published = await waitFor('revision');
  assert.equal(published.draftRevision, null);
  assert.notEqual(published.revision, candidate.revision);
  assert.equal((await request('POST', path + '/preview/request', apiRequest, owner)).statusCode, 409);
});

test('the owner can stop an active browser acceptance without publishing its draft', async (t) => {
  const data = await mkdtemp(join(tmpdir(), 'site-builder-stop-'));
  const browserStarted = Promise.withResolvers();
  const browserCancelled = Promise.withResolvers();
  const app = await createApp({
    data, origin, demo: true, deepseekKey: 'test',
    async completion() {
      return '{"changes":{"notice.html":"<h1>Notice</h1>"}}';
    },
    async testBrowser(_files, _actions, signal) {
      browserStarted.resolve();
      await delay(10000, null, { signal }).catch(() => browserCancelled.resolve());
      return { status: 'passed' };
    }
  });
  t.after(async () => {
    await app.close();
    await rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const request = (method, path, payload, cookie) => app.inject({
    method, url: '/api/' + path, payload, headers: { origin, cookie }
  });
  const owner = (await request('POST', 'register', { name: 'stop-owner', password: 'stop-test' }, '')).headers['set-cookie'].split(';')[0];
  const outsider = (await request('POST', 'register', { name: 'stop-outsider', password: 'stop-test' }, '')).headers['set-cookie'].split(';')[0];
  const created = await request('POST', 'projects', { name: 'Stop test' }, owner);
  const path = 'projects/' + created.json().id;
  const get = async () => (await request('GET', path, undefined, owner)).json();
  const start = async (modelId) => (await request('POST', path + '/generate', { prompt: 'Create a task site.', modelId }, owner)).json().id;
  async function finished(id) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const message = (await get()).messages.find((entry) => entry.id === id);
      if (message?.state !== 'running') return message;
      await delay(20);
    }
    assert.fail('timed out waiting for generation');
  }
  assert.equal((await finished(await start('demo'))).state, 'complete');
  const baseline = (await get()).project.revision;
  const id = await start('platform');
  await browserStarted.promise;
  const stop = path + '/messages/' + id + '/stop';
  assert.equal((await request('POST', stop, {}, outsider)).statusCode, 404);
  const active = (await get()).messages.find((entry) => entry.id === id);
  assert.equal(active.agent_progress, '正在检查候选网站…');
  assert.equal((await request('POST', stop, {}, owner)).statusCode, 202);
  await browserCancelled.promise;
  const stopped = await finished(id);
  assert.equal(stopped.state, 'stopped');
  assert.deepEqual(stopped.agent_events, active.agent_events);
  assert.deepEqual((await request('POST', stop, {}, owner)).json(), { state: 'stopped' });
  assert.equal((await get()).project.revision, baseline);
  assert.equal((await get()).project.preview, 'running');
});

test('complete build workflow, account boundaries and rollback', async (t) => {
  const data = await mkdtemp(join(tmpdir(), 'site-builder-test-'));
  let wasCustom = false;
  const reasoningStarted = Promise.withResolvers();
  const finishFirstGeneration = Promise.withResolvers();
  const app = await createApp({
    data, origin, deepseekKey: 'test-platform', demo: true, dailyUser: 1,
    async completion(config, messages, limit, options) {
      wasCustom = config.key === 'example-secret';
      if (limit === 16) return 'OK';
      const input = messages[1].content.split('\n')[1];
      const current = input.startsWith('{') ? JSON.parse(input).request : input;
      if (current === 'question only') return JSON.stringify({ answer: '待办数据存在项目 SQLite 中。' });
      if (config.platform) {
        assert.equal(limit, 32000);
        options.onReasoning('正在规划页面。');
        reasoningStarted.resolve();
        await finishFirstGeneration.promise;
        options.onReasoning('已确定数据结构。');
      }
      const broken = current === 'broken backend';
      if (wasCustom && messages.length === 2) return JSON.stringify({ read: [broken ? 'server.js' : 'index.html'] });
      if (broken) {
        const result = JSON.parse(demoCompletion(config, messages));
        result.changes = { 'server.js': "function setup() { db.insert('tasks', {title:'should roll back'}); throw Error('broken'); } function handle() {}" };
        return JSON.stringify(result);
      }
      return demoCompletion(config, messages);
    },
    testBrowser(_files, actions) { return passed(actions); }
  });
  t.after(async () => {
    await app.close();
    await rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const request = (method, path, payload, cookie, requestOrigin = origin) => app.inject({
    method, url: '/api/' + path, payload,
    headers: { origin: requestOrigin, ...(cookie ? { cookie } : {}) }
  });
  const register = async (name) => {
    const result = await request('POST', 'register', { name, password: '123456' });
    assert.equal(result.statusCode, 201, result.body);
    return result.headers['set-cookie'].split(';')[0];
  };
  assert.equal((await request('POST', 'register', { name: 'builder-one', password: '12345' })).statusCode, 400);
  const owner = await register('builder-one');
  const outsider = await register('builder-two');
  const projectResponse = await request('POST', 'projects', { name: '每日待办' }, owner);
  assert.equal(projectResponse.statusCode, 201);
  const project = 'projects/' + projectResponse.json().id;

  async function complete(prompt, modelId = 'platform') {
    const result = await request('POST', project + '/generate', { prompt, modelId }, owner);
    assert.equal(result.statusCode, 202, result.body);
    for (let attempt = 0; attempt < 100; attempt++) {
      const item = (await request('GET', project, undefined, owner)).json().messages.find((message) => message.id === result.json().id);
      if (item.state !== 'running') return item;
      await delay(40);
    }
    assert.fail('Generation failed to complete');
  }

  const initialGeneration = complete('做一个待办网站');
  await reasoningStarted.promise;
  let reasoningPath;
  try {
    const inProgress = (await request('GET', project, undefined, owner)).json().messages[0];
    assert.equal(inProgress.state, 'running');
    assert.equal(inProgress.has_reasoning, 1);
    assert.equal(Object.hasOwn(inProgress, 'reasoning'), false);
    reasoningPath = project + '/messages/' + inProgress.id + '/reasoning';
    assert.equal((await request('GET', reasoningPath, undefined, owner)).json().reasoning, '正在规划页面。');
    assert.equal((await request('GET', reasoningPath, undefined, outsider)).statusCode, 404);
  } finally {
    finishFirstGeneration.resolve();
  }
  assert.equal((await initialGeneration).state, 'complete');
  assert.equal((await request('GET', reasoningPath, undefined, owner)).json().reasoning, '正在规划页面。已确定数据结构。');
  const source = (await request('GET', project + '/source', undefined, owner)).json();
  assert.equal(source.version, 1);
  assert.match(source.files['server.js'], /function handle/);
  const previewPath = project + '/preview';
  const initialPreview = await request('GET', previewPath, undefined, owner);
  assert.equal(initialPreview.statusCode, 200, initialPreview.body);
  assert.equal(Object.hasOwn(initialPreview.json().files, 'server.js'), false);
  const call = (method, path, body, revision = source.revision, cookie = owner) =>
    request('POST', previewPath + '/request', { method, path, body, revision }, cookie);
  const added = (await call('POST', '/api/tasks', { title: '持久化这条记录' })).json();
  assert.equal(added.status, 201);
  assert.equal((await call('PATCH', '/api/tasks/' + added.body.id, { done: true })).json().body.done, true);
  assert.equal((await request('GET', previewPath, undefined, outsider)).statusCode, 404);
  assert.equal((await request('GET', project + '/source', undefined, outsider)).statusCode, 404);
  assert.equal((await request('POST', project + '/preview/stop', {}, owner, 'null')).statusCode, 403);
  assert.equal((await request('POST', project + '/generate', { prompt: '超过额度' }, owner)).statusCode, 429);

  const shareAdmin = project + '/share';
  const shareCreated = await request('POST', shareAdmin, {}, owner);
  assert.equal(shareCreated.statusCode, 201, shareCreated.body);
  const firstLink = shareCreated.json().share;
  assert.equal(firstLink.version, 1);
  assert.equal((await request('GET', shareAdmin, undefined, owner)).json().share.url, firstLink.url);
  assert.equal((await request('GET', shareAdmin, undefined, outsider)).statusCode, 404);
  const sharePath = 'shares/' + new URL(firstLink.url).searchParams.get('share');
  const shared = (await request('GET', sharePath)).json();
  assert.equal(shared.name, '每日待办');
  assert.equal(Object.hasOwn(shared.files, 'server.js'), false);
  const guestCall = (method, body) => request('POST', sharePath + '/request', {
    revision: shared.revision, path: '/api/tasks', method, body
  });
  const anonymousStart = await guestCall('GET');
  assert.equal(anonymousStart.statusCode, 200, anonymousStart.body);
  assert.deepEqual(anonymousStart.json().body, []);
  assert.equal((await guestCall('POST', { title: '访客待办' })).json().status, 201);
  assert.deepEqual((await call('GET', '/api/tasks')).json().body, [{ ...added.body, done: true }]);

  const modelSettings = { name: 'My model', key: 'example-secret', model: 'custom-model', baseUrl: 'https://api.example.com/v1' };
  const model = (await request('POST', 'models', modelSettings, owner)).json();
  assert.equal(model.key, undefined);
  assert.equal((await request('GET', 'models', undefined, outsider)).json().some((item) => item.id === model.id), false);
  assert.equal((await request('POST', 'models/test', { ...modelSettings, key: '', id: model.id }, owner)).statusCode, 200);
  assert.equal(wasCustom, true);
  const reply = await complete('question only', model.id);
  assert.equal(reply.state, 'complete');
  assert.equal(reply.result_type, 'answer');
  assert.equal(reply.response, '待办数据存在项目 SQLite 中。');
  assert.equal((await request('GET', project + '/source', undefined, owner)).json().revision, source.revision);
  assert.equal((await call('GET', '/api/tasks')).json().body.length, 1);
  assert.equal((await complete('broken backend', model.id)).state, 'failed');
  assert.equal((await call('GET', '/api/tasks')).json().body.length, 1);
  assert.equal((await complete('按完成状态筛选', model.id)).state, 'complete');
  const latest = (await request('GET', project + '/source', undefined, owner)).json();
  assert.equal(latest.version, 2);
  assert.match(latest.files['index.html'], /已完成/);
  assert.equal((await call('GET', '/api/tasks')).statusCode, 409);
  assert.deepEqual((await call('GET', '/api/tasks', null, latest.revision)).json().body, [{ ...added.body, done: true }]);
  assert.equal((await request('GET', sharePath)).json().version, 1);
  assert.equal((await request('GET', shareAdmin, undefined, owner)).json().share.current, false);
  assert.equal((await guestCall('GET')).json().body[0].title, '访客待办');
  const replacement = await request('POST', shareAdmin, {}, owner);
  assert.equal(replacement.json().share.version, 2);
  assert.equal((await request('GET', sharePath)).statusCode, 404);
  assert.equal((await guestCall('GET')).statusCode, 404);
  const replacementPath = 'shares/' + new URL(replacement.json().share.url).searchParams.get('share');
  assert.equal((await request('GET', replacementPath)).statusCode, 200);
  assert.equal((await request('DELETE', shareAdmin, undefined, owner)).statusCode, 200);
  assert.equal((await request('GET', replacementPath)).statusCode, 404);

  assert.equal((await request('POST', project + '/preview/stop', {}, owner)).statusCode, 200);
  assert.equal((await call('GET', '/api/tasks', null, latest.revision)).statusCode, 409);
  assert.equal((await request('POST', project + '/preview/start', {}, owner)).statusCode, 200);
  assert.equal((await call('GET', '/api/tasks', null, latest.revision)).json().body.length, 1);
  assert.equal((await request('POST', 'logout', {}, owner)).statusCode, 200);
  assert.equal((await request('GET', previewPath, undefined, owner)).statusCode, 401);
  const login = await request('POST', 'login', { name: 'builder-one', password: '123456' });
  assert.equal(login.statusCode, 200);
  const newSession = login.headers['set-cookie'].split(';')[0];
  assert.equal((await request('GET', 'models', undefined, newSession)).json().some((item) => item.id === model.id), true);
  assert.equal((await request('DELETE', project, undefined, newSession)).statusCode, 200);
  assert.equal((await request('GET', project, undefined, newSession)).statusCode, 404);
});

test('compatible endpoints accept only public HTTPS destinations', () => {
  for (const address of ['127.0.0.1', '10.20.30.40', '169.254.169.254', '100.100.100.200', '198.18.0.1', '::1', '::ffff:127.0.0.1', '3fff::1', '2001:db8::1']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  for (const url of ['http://api.example.com', 'https://127.0.0.1', 'https://localhost', 'https://user@api.example.com', 'https://api.example.com/#fragment']) {
    assert.throws(() => parseEndpoint(url));
  }
  assert.equal(parseEndpoint('https://api.example.com/v1/').href, 'https://api.example.com/v1');
});

test('zero daily limits allow generation after previous usage', async (t) => {
  const data = await mkdtemp(join(tmpdir(), 'site-builder-no-quota-'));
  const app = await createApp({
    data, origin, deepseekKey: 'test-platform', dailyUser: 0, dailyGlobal: 0, dailyCustom: 0,
    completion: demoCompletion
  });
  t.after(async () => {
    await app.close();
    await rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const register = await app.inject({
    method: 'POST', url: '/api/register', headers: { origin }, payload: { name: 'past-limit', password: '123456' }
  });
  assert.equal(register.statusCode, 201);
  const headers = { origin, cookie: register.headers['set-cookie'].split(';')[0] };
  const user = register.json().user.id;
  const db = new DatabaseSync(join(data, 'platform.sqlite'));
  const day = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  for (const subject of [user + ':platform', 'platform:all', user + ':custom']) {
    db.prepare('INSERT INTO quota VALUES (?, ?, ?)').run(day, subject, 500);
  }
  db.close();
  const model = await app.inject({
    method: 'POST', url: '/api/models', headers,
    payload: { name: 'Test model', baseUrl: 'https://api.example.com/v1', model: 'test', key: 'test-secret' }
  });
  assert.equal(model.statusCode, 201);
  for (const [index, modelId] of ['platform', model.json().id].entries()) {
    const project = await app.inject({ method: 'POST', url: '/api/projects', headers, payload: { name: 'Project ' + index } });
    assert.equal(project.statusCode, 201);
    const result = await app.inject({
      method: 'POST', url: '/api/projects/' + project.json().id + '/generate', headers, payload: { prompt: 'Generate a site.', modelId }
    });
    assert.equal(result.statusCode, 202, result.body);
  }
});
