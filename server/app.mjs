import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { LogController } from 'fastify';
import { chatCompletion, isDeepSeek, parseEndpoint, PublicError } from './models.mjs';
import { buildProject } from './agent-workflow.mjs';
import { loadProjectMemory } from './project-memory.mjs';
import { makeBrowserTester } from './browser-tester.mjs';
import { previewInput } from './preview-requests.mjs';
import { checkPassword, cookieValue, hashPassword, openStore, sessionLifetime, token } from './storage.mjs';
import { makePreviews } from './preview.mjs';
import { demoCompletion } from './demo.mjs';

const id = () => randomUUID().replaceAll('-', '');
const dayKey = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const sessionKey = (request) => cookieValue(request.headers.cookie);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const assetTypes = { js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml' };

function field(value, label, max, min = 1) {
  const result = typeof value === 'string' ? value.trim() : '';
  if (result.length < min || result.length > max) throw new PublicError(400, label + '长度应为 ' + min + '–' + max + ' 个字符。');
  return result;
}

function previewRequest(value) {
  if (typeof value?.revision !== 'string') throw new PublicError(400, '预览版本无效。');
  return { revision: value.revision, input: previewInput(value) };
}

function browserFiles(serialized) {
  const files = JSON.parse(serialized);
  delete files['server.js'];
  return files;
}

export async function createApp(config) {
  const app = Fastify({
    logger: config.logger ?? false, bodyLimit: 80000, trustProxy: ['127.0.0.1', '::1'],
    logController: new LogController({ disableRequestLogging: true })
  });
  const store = openStore(config.data, config.encryptionKey);
  const preview = makePreviews(join(config.data, 'previews'), {
    launcher: config.launcher, max: config.maxPreviews ?? 2, idleMs: config.idleMs ?? 900000, log: app.log
  });
  const sharedPreview = makePreviews(join(config.data, 'previews'), {
    launcher: config.launcher, max: config.maxSharedPreviews ?? 2, idleMs: config.idleMs ?? 900000, log: app.log
  });
  const shareWindow = config.shareWindow ?? 86400000;
  const tasks = new Map();
  const draftPreviews = new Map();
  const completion = config.completion ?? chatCompletion;
  const testBrowser = config.testBrowser ?? makeBrowserTester(config.browserLauncher);
  const prefix = config.basePath ?? '';
  const platform = { id: 'platform', name: 'DeepSeek', model: config.deepseekModel || 'deepseek-flash', source: 'platform', available: Boolean(config.deepseekKey) };
  const demo = { id: 'demo', name: '待办演示', model: '内置示例', source: 'demo', available: true };
  const attempts = new Map();
  const throttle = setInterval(() => {
    for (const [key, entry] of attempts) if (entry.until <= Date.now()) attempts.delete(key);
  }, 60000);
  throttle.unref();

  function limit(key, max, duration) {
    const now = Date.now();
    const entry = attempts.get(key);
    if (!entry || now >= entry.until) {
      attempts.set(key, { until: now + duration, uses: 1 });
      return;
    }
    if (entry.uses >= max) throw new PublicError(429, '请求过于频繁，请稍后再试。');
    entry.uses++;
  }
  function quota(subject, max) {
    const day = dayKey();
    if (max > 0) {
      const count = store.get('SELECT count FROM quota WHERE day = ? AND subject = ?', day, subject)?.count ?? 0;
      if (count >= max) throw new PublicError(429, '已达到今天的调用额度，可切换其他模型或明天再试。');
    }
    store.run('INSERT INTO quota VALUES (?, ?, 1) ON CONFLICT(day, subject) DO UPDATE SET count = count + 1', day, subject);
  }
  function user(request) {
    const account = store.session(sessionKey(request));
    if (!account) throw new PublicError(401, '请先登录。');
    return account;
  }
  function project(projectId, owner) {
    const found = store.get('SELECT * FROM projects WHERE id = ? AND user_id = ?', projectId, owner);
    if (!found) throw new PublicError(404, '项目不存在。');
    return found;
  }
  const ownedProject = (request) => project(request.params.id, user(request).id);
  function revision(item) {
    if (!item.active_revision) throw new PublicError(409, '请先生成一个网站版本。');
    return store.get('SELECT id, version, files FROM revisions WHERE project_id = ? AND id = ?', item.id, item.active_revision);
  }
  const shareProject = (row) => ({ id: 'share:' + row.id, user_id: row.id, active_revision: row.id });
  const retireShare = (row) => sharedPreview.delete(shareProject(row).id, () => [{ id: row.id }]);
  function publicShare(accessToken) {
    const row = typeof accessToken === 'string' && /^[a-zA-Z0-9_-]{43}$/.test(accessToken)
      ? store.get(`SELECT shares.*, projects.name, revisions.version, revisions.files FROM shares
          JOIN projects ON projects.id = shares.project_id JOIN revisions ON revisions.id = shares.revision_id
          WHERE token_hash = ? AND expires > ?`, digest(accessToken), Date.now())
      : undefined;
    if (!row) throw new PublicError(404, '分享链接不存在、已过期或已撤销。');
    return row;
  }
  function shareDetails(item, row) {
    if (!row || row.expires <= Date.now()) return null;
    const value = store.decrypt({ ...row, user_id: item.user_id });
    const url = new URL(prefix + '/', config.origin);
    url.searchParams.set('share', value);
    return { url: url.href, expires: row.expires, version: row.version, current: row.revision_id === item.active_revision };
  }
  const expiryTimer = setInterval(() => {
    const expired = store.transaction(() => {
      const now = Date.now();
      const rows = store.all('SELECT id FROM shares WHERE expires <= ?', now);
      store.run('DELETE FROM shares WHERE expires <= ?', now);
      return rows;
    });
    for (const row of expired) {
      void retireShare(row).catch((error) => app.log.warn({ code: error.code }, 'Share cleanup failed'));
    }
  }, 60000);
  expiryTimer.unref();
  const projectView = (item) => ({
    id: item.id, name: item.name, updated: item.updated, revision: item.active_revision, preview: preview.status(item.id),
    draftRevision: activeDraft(item)?.id ?? null
  });
  function activeDraft(item) {
    const draft = draftPreviews.get(item.id);
    return !item.active_revision && draft && preview.status(draft.key) === 'running' ? draft : undefined;
  }
  function modelRow(modelId, owner) {
    const model = store.get('SELECT * FROM models WHERE id = ? AND user_id = ?', modelId, owner);
    if (!model) throw new PublicError(404, '模型配置不存在。');
    return model;
  }
  const modelView = (row) => ({ id: row.id, name: row.name, baseUrl: row.base_url, model: row.model, source: 'custom', available: true });
  function modelConfig(modelId, owner) {
    if (modelId === 'platform') {
      if (!config.deepseekKey) throw new PublicError(503, '平台 DeepSeek Key 尚未配置，请切换至自带模型。');
      return { name: platform.name, model: platform.model, key: config.deepseekKey, baseUrl: 'https://api.deepseek.com', platform: true };
    }
    if (modelId === 'demo' && config.demo) return demo;
    const row = modelRow(modelId, owner);
    return { ...modelView(row), key: store.decrypt(row) };
  }
  function readModel(value, existing) {
    const name = field(value?.name, '配置名称', 48);
    const model = field(value?.model, '模型名', 160);
    const baseUrl = parseEndpoint(field(value?.baseUrl, '接口地址', 500)).href;
    const key = typeof value?.key === 'string' && value.key.trim() ? field(value.key, 'API Key', 1024) : '';
    if (!key && (!existing || existing.base_url !== baseUrl)) throw new PublicError(400, '请为该接口地址填写 API Key。');
    if (/[\r\n]/.test(key)) throw new PublicError(400, 'API Key 不能包含换行。');
    return { name, model, baseUrl, key };
  }
  const cookie = (value, age) => 'builder_session=' + (value ?? '') + '; Path=' + (prefix || '') +
    '/; HttpOnly; SameSite=Lax; Max-Age=' + age + (config.origin.startsWith('https:') ? '; Secure' : '');
  const route = (method, path, handler) => app.route({ method, url: prefix + '/api' + path, handler });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', "frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
    if (request.url.startsWith(prefix + '/api/')) {
      reply.header('Cache-Control', 'no-store');
      if (!['GET', 'HEAD'].includes(request.method) && request.headers.origin !== config.origin) throw new PublicError(403, '请求来源无效。');
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof PublicError) return reply.code(error.statusCode).send({ error: error.message });
    if (error.statusCode && error.statusCode < 500) return reply.code(error.statusCode).send({ error: '请求格式无效。' });
    app.log.error({ name: error.name, code: error.code }, 'Unhandled request error');
    return reply.code(500).send({ error: '服务暂时不可用，请稍后重试。' });
  });
  route('GET', '/session', async (request) => ({ user: store.session(sessionKey(request)) ?? null, platform }));
  route('POST', '/register', async (request, reply) => {
    limit('register:' + request.ip, 8, 3600000);
    const name = field(request.body?.name, '用户名', 24, 2);
    if (!/^[\p{L}\p{N}_-]+$/u.test(name)) throw new PublicError(400, '用户名只能包含文字、数字、下划线和连字符。');
    const password = request.body?.password;
    if (typeof password !== 'string' || password.length < 6 || password.length > 128) throw new PublicError(400, '密码长度应为 6–128 个字符。');
    const hashed = await hashPassword(password);
    if (store.get('SELECT id FROM users WHERE name = ?', name)) throw new PublicError(409, '这个用户名已被使用。');
    const account = { id: id(), name };
    store.run('INSERT INTO users VALUES (?, ?, ?)', account.id, name, hashed);
    store.endSession(sessionKey(request));
    return reply.code(201).header('Set-Cookie', cookie(store.createSession(account.id), sessionLifetime)).send({ user: account });
  });
  route('POST', '/login', async (request, reply) => {
    limit('login:' + request.ip, 15, 900000);
    const name = field(request.body?.name, '用户名', 24, 2);
    const password = request.body?.password;
    if (typeof password !== 'string' || !password.length || password.length > 128) throw new PublicError(400, '请输入有效密码。');
    const account = store.get('SELECT * FROM users WHERE name = ?', name);
    if (!await checkPassword(password, account?.password)) throw new PublicError(401, '用户名或密码不正确。');
    store.endSession(sessionKey(request));
    return reply.header('Set-Cookie', cookie(store.createSession(account.id), sessionLifetime)).send({ user: { id: account.id, name: account.name } });
  });
  route('POST', '/logout', async (request, reply) => {
    store.endSession(sessionKey(request));
    return reply.header('Set-Cookie', cookie(null, 0)).send({ ok: true });
  });
  route('GET', '/projects', async (request) =>
    store.all('SELECT * FROM projects WHERE user_id = ? ORDER BY updated DESC', user(request).id).map(projectView));
  route('POST', '/projects', async (request, reply) => {
    const owner = user(request).id;
    const name = field(request.body?.name, '项目名称', 60);
    if (store.get('SELECT count(*) AS count FROM projects WHERE user_id = ?', owner).count >= 30) throw new PublicError(409, '项目数量已达上限。');
    const item = { id: id(), name, user_id: owner, updated: Date.now(), active_revision: null };
    store.run('INSERT INTO projects VALUES (?, ?, ?, ?, NULL)', item.id, owner, name, item.updated);
    return reply.code(201).send(projectView(item));
  });
  route('GET', '/projects/:id', async (request) => {
    const item = ownedProject(request);
    const records = store.all(`SELECT messages.id, prompt, model_id, model_name, state, response, created, result_type, agent_progress, agent_events,
      message_reasoning.message_id IS NOT NULL AS has_reasoning FROM messages
      LEFT JOIN message_reasoning ON message_reasoning.message_id = messages.id
      WHERE project_id = ? ORDER BY created, messages.rowid`, item.id);
    return { project: projectView(item), messages: records.map(({ agent_events, ...record }) => ({
      ...record, agent_events: agent_events ? JSON.parse(agent_events) : []
    })) };
  });
  route('GET', '/projects/:id/messages/:messageId/reasoning', async (request) => {
    const item = ownedProject(request);
    const row = store.get(`SELECT message_reasoning.body AS reasoning, messages.state FROM messages
      LEFT JOIN message_reasoning ON message_reasoning.message_id = messages.id
      WHERE messages.id = ? AND messages.project_id = ?`, request.params.messageId, item.id);
    if (!row) throw new PublicError(404, '找不到该条对话。');
    return row;
  });
  route('PATCH', '/projects/:id', async (request) => {
    const item = ownedProject(request);
    store.run('UPDATE projects SET name = ?, updated = ? WHERE id = ?', field(request.body?.name, '项目名称', 60), Date.now(), item.id);
    return projectView(ownedProject(request));
  });
  route('DELETE', '/projects/:id', async (request) => {
    const item = ownedProject(request);
    const running = store.get("SELECT id FROM messages WHERE project_id = ? AND state = 'running'", item.id);
    if (running) tasks.get(running.id)?.controller.abort();
    let shared;
    await preview.delete(item.id, () => {
      ownedProject(request);
      const revisions = store.all('SELECT id FROM revisions WHERE project_id = ?', item.id);
      shared = store.get('SELECT id FROM shares WHERE project_id = ?', item.id);
      store.run('DELETE FROM projects WHERE id = ?', item.id);
      return revisions;
    });
    if (shared) await retireShare(shared);
    return { ok: true };
  });
  route('GET', '/projects/:id/source', async (request) => {
    const rev = revision(ownedProject(request));
    return { revision: rev.id, version: rev.version, files: JSON.parse(rev.files) };
  });
  route('POST', '/projects/:id/generate', async (request, reply) => {
    const item = ownedProject(request);
    const prompt = field(request.body?.prompt, '需求', 6000);
    const modelId = field(request.body?.modelId ?? 'platform', '模型', 64);
    const model = modelConfig(modelId, item.user_id);
    const messageId = id();
    store.transaction(() => {
      if (store.get("SELECT id FROM messages WHERE project_id = ? AND state = 'running'", item.id)) throw new PublicError(409, '这个项目正在生成，请等待当前请求完成。');
      if (tasks.size >= (config.generationConcurrency ?? 4)) throw new PublicError(503, '生成任务较多，请稍后重试。');
      if (modelId === 'platform') {
        quota(item.user_id + ':platform', config.dailyUser ?? 5);
        quota('platform:all', config.dailyGlobal ?? 100);
      } else {
        quota(item.user_id + ':' + (modelId === 'demo' ? 'demo' : 'custom'), config.dailyCustom ?? 30);
      }
      const now = Date.now();
      store.run('INSERT INTO messages (id, project_id, prompt, model_id, model_name, state, created) VALUES (?, ?, ?, ?, ?, ?, ?)',
        messageId, item.id, prompt, modelId, model.name, 'running', now);
      store.run('UPDATE projects SET updated = ? WHERE id = ?', now, item.id);
    });
    const controller = new AbortController();
    const { signal } = controller;
    const task = (async () => {
      const events = [];
      const draftController = new AbortController();
      const draftSignal = AbortSignal.any([signal, draftController.signal]);
      let draft;
      let draftStart;
      async function discardDraft() {
        draftController.abort();
        if (draftPreviews.get(item.id) === draft) draftPreviews.delete(item.id);
        await draftStart;
        if (draft) {
          await preview.delete(draft.key, () => [{ id: draft.id }]);
          draft = undefined;
        }
      }
      const reasoningLimit = 16000;
      let reasoning = '';
      let savedReasoning = '';
      let lastReasoningWrite = 0;
      let reasoningTruncated = false;
      const flushReasoning = () => {
        const value = reasoningTruncated ? reasoning + '\n\n[其余思考内容已省略]' : reasoning;
        if (value === savedReasoning) return;
        store.run(`INSERT INTO message_reasoning (message_id, body) SELECT id, ? FROM messages WHERE id = ?
          ON CONFLICT(message_id) DO UPDATE SET body = excluded.body`, value, messageId);
        savedReasoning = value;
        lastReasoningWrite = Date.now();
      };
      try {
        const prior = item.active_revision ? revision(item) : undefined;
        const teamRequired = modelId !== 'demo' && Boolean(store.get(`
          SELECT 1 FROM messages
          WHERE project_id = ? AND prompt = ? AND state IN ('failed', 'stopped')
          AND EXISTS (
            SELECT 1 FROM json_each(CASE WHEN json_valid(agent_events) THEN agent_events END) AS event
            WHERE event.value ->> 'kind' = 'assign' AND event.value ->> 'role' IN ('frontend', 'backend')
          )
          LIMIT 1`, item.id, prompt));
        const memory = modelId === 'demo' ? undefined : await loadProjectMemory(store, item.id, model, completion, (error) => {
          app.log.warn({ project: item.id, name: error.name, code: error.code }, 'Could not update project memory');
        }, signal);
        signal.throwIfAborted();
        const output = await buildProject(model, prompt, prior ? JSON.parse(prior.files) : undefined,
          modelId === 'demo' ? demoCompletion : completion, {
            memory, signal, teamRequired,
            testBrowser,
            onCandidate(files) {
              if (item.active_revision || draftStart || draftSignal.aborted) return;
              const candidate = { id: id(), key: 'draft:' + messageId, files: JSON.stringify(files) };
              const draftProject = { ...item, id: candidate.key, active_revision: candidate.id };
              draftStart = preview.start(draftProject, () => ({
                current: draftProject, revision: candidate,
                initialize() {
                  draftSignal.throwIfAborted();
                  if (project(item.id, item.user_id).active_revision) throw new PublicError(409, '项目已经发布。');
                  draft = candidate;
                  draftPreviews.set(item.id, candidate);
                }
              }), draftSignal).catch((error) => {
                if (!(error instanceof PublicError) && !draftSignal.aborted) app.log.warn({ name: error.name }, 'Could not start draft preview');
              }).finally(() => { if (!draft) draftStart = undefined; });
            },
            maxTokens: isDeepSeek(model)
              ? (config.deepseekMaxTokens ?? 32000)
              : (config.maxTokens ?? 10000),
            onProgress(stage) {
              if (signal.aborted) return;
              store.run("UPDATE messages SET agent_progress = ? WHERE id = ? AND state = 'running'", stage || null, messageId);
            },
            onAgentEvent(event) {
              if (signal.aborted || events.length >= 256) return;
              events.push(event);
              store.run("UPDATE messages SET agent_events = ? WHERE id = ? AND state = 'running'", JSON.stringify(events), messageId);
            },
            onReasoning(chunk) {
              if (signal.aborted || reasoningTruncated) return;
              reasoning += chunk;
              reasoningTruncated = reasoning.length > reasoningLimit;
              if (reasoningTruncated) reasoning = reasoning.slice(0, reasoningLimit);
              if (Date.now() - lastReasoningWrite >= 800) flushReasoning();
            }
          });
        signal.throwIfAborted();
        flushReasoning();
        await discardDraft();
        signal.throwIfAborted();
        if (!output.files) {
          store.run("UPDATE messages SET state = 'complete', result_type = 'answer', response = ? WHERE id = ?", output.summary, messageId);
          return;
        }
        const active = project(item.id, item.user_id);
        if (active.active_revision !== item.active_revision) throw new PublicError(409, '项目版本已变化，请重新提交修改。');
        const next = id();
        await preview.activate(active, next, output.files, () => store.transaction(() => {
          signal.throwIfAborted();
          if (project(item.id, item.user_id).active_revision !== item.active_revision) {
            throw new PublicError(409, '项目版本已变化，请重新提交修改。');
          }
          store.run('INSERT INTO revisions VALUES (?, ?, ?, ?)', next, item.id, (prior?.version ?? 0) + 1, JSON.stringify(output.files));
          store.run('UPDATE projects SET active_revision = ?, updated = ? WHERE id = ?', next, Date.now(), item.id);
          store.run("UPDATE messages SET state = 'complete', result_type = 'revision', response = ? WHERE id = ?", output.summary, messageId);
        }), signal);
      } catch (error) {
        flushReasoning();
        if (signal.aborted) {
          store.run("UPDATE messages SET state = 'stopped', agent_progress = NULL, response = ? WHERE id = ?", '已停止生成。', messageId);
          return;
        }
        if (!(error instanceof PublicError)) app.log.error({ project: item.id, code: error.code, name: error.name }, 'Generation failed');
        store.run("UPDATE messages SET state = 'failed', response = ? WHERE id = ?", error instanceof PublicError ? error.message : '生成失败，请稍后重试。', messageId);
      } finally {
        await discardDraft();
      }
    })();
    tasks.set(messageId, { task, controller });
    task.finally(() => tasks.delete(messageId)).catch((error) => app.log.error({ code: error.code }, 'Could not finish task'));
    return reply.code(202).send({ id: messageId });
  });
  route('POST', '/projects/:id/messages/:messageId/stop', async (request, reply) => {
    const item = ownedProject(request);
    const row = store.get('SELECT id, state FROM messages WHERE project_id = ? AND id = ?', item.id, request.params.messageId);
    if (!row) throw new PublicError(404, '找不到该条对话。');
    if (row.state !== 'running') return { state: row.state };
    const job = tasks.get(row.id);
    if (!job) throw new PublicError(409, '这轮生成已结束，请刷新对话。');
    store.run("UPDATE messages SET agent_progress = ? WHERE id = ?", '正在停止生成…', row.id);
    job.controller.abort();
    return reply.code(202).send({ state: 'running' });
  });
  route('POST', '/projects/:id/preview/start', async (request) => {
    const item = ownedProject(request);
    await preview.start(item, () => {
      const current = ownedProject(request);
      return { current, revision: revision(current) };
    });
    return projectView(ownedProject(request));
  });
  route('POST', '/projects/:id/preview/stop', async (request) => {
    const item = ownedProject(request);
    await preview.stop(item.id);
    return projectView(ownedProject(request));
  });
  route('GET', '/projects/:id/preview', async (request) => {
    const item = ownedProject(request);
    const draft = activeDraft(item);
    if (draft) {
      preview.touch(draft.key, draft.id);
      return { revision: draft.id, version: 0, files: browserFiles(draft.files) };
    }
    const rev = revision(item);
    preview.touch(item.id, rev.id);
    return { revision: rev.id, version: rev.version, files: browserFiles(rev.files) };
  });
  route('POST', '/projects/:id/preview/request', async (request) => {
    const item = ownedProject(request);
    const { revision: rev, input } = previewRequest(request.body);
    limit('preview:' + item.id, 240, 60000);
    const draft = activeDraft(item);
    if (draft?.id === rev) {
      return preview.request(draft.key, rev, input, () => {
        if (activeDraft(ownedProject(request))?.id !== rev) throw new PublicError(409, '候选预览已结束。');
      });
    }
    return preview.request(item.id, rev, input, () => {
      if (ownedProject(request).active_revision !== rev) throw new PublicError(409, '预览版本已更新。');
    });
  });
  route('GET', '/projects/:id/share', async (request) => {
    const item = ownedProject(request);
    const row = store.get('SELECT shares.*, revisions.version FROM shares JOIN revisions ON revisions.id = shares.revision_id WHERE shares.project_id = ?', item.id);
    return { share: shareDetails(item, row) };
  });
  route('POST', '/projects/:id/share', async (request, reply) => {
    const item = ownedProject(request);
    const rev = revision(item);
    limit('share-create:' + item.user_id, 20, 3600000);
    const value = token();
    const row = { id: id(), project_id: item.id, revision_id: rev.id, expires: Date.now() + shareWindow, version: rev.version };
    row.secret = store.encrypt(value, row.id, item.user_id);
    const replaced = store.transaction(() => {
      const previous = store.get('SELECT id FROM shares WHERE project_id = ?', item.id);
      store.run('DELETE FROM shares WHERE project_id = ?', item.id);
      store.run('INSERT INTO shares (id, project_id, revision_id, token_hash, secret, expires) VALUES (?, ?, ?, ?, ?, ?)',
        row.id, item.id, rev.id, digest(value), row.secret, row.expires);
      return previous;
    });
    if (replaced) await retireShare(replaced);
    return reply.code(201).send({ share: shareDetails(item, row) });
  });
  route('DELETE', '/projects/:id/share', async (request) => {
    const item = ownedProject(request);
    const row = store.get('SELECT id FROM shares WHERE project_id = ?', item.id);
    if (row) {
      store.run('DELETE FROM shares WHERE id = ?', row.id);
      await retireShare(row);
    }
    return { ok: true };
  });
  route('GET', '/shares/:token', async (request, reply) => {
    reply.header('X-Robots-Tag', 'noindex, nofollow, noarchive');
    limit('share-view:' + request.ip, 120, 60000);
    const row = publicShare(request.params.token);
    return { name: row.name, revision: row.id, version: row.version, files: browserFiles(row.files) };
  });
  route('POST', '/shares/:token/request', async (request) => {
    limit('share-guest:' + request.ip, 240, 60000);
    const accessToken = request.params.token;
    const row = publicShare(accessToken);
    const { revision: rev, input } = previewRequest(request.body);
    if (rev !== row.id) throw new PublicError(409, '分享版本已更新。');
    limit('share-runtime:' + row.id, 360, 60000);
    const project = shareProject(row);
    await sharedPreview.start(project, () => {
      const latest = publicShare(accessToken);
      return {
        current: shareProject(latest),
        revision: latest,
        initialize: latest.initialized ? undefined : () => {
          publicShare(accessToken);
          store.run('UPDATE shares SET initialized = 1 WHERE id = ?', latest.id);
        }
      };
    });
    return sharedPreview.request(project.id, rev, input, () => publicShare(accessToken));
  });
  route('GET', '/models', async (request) => [
    platform, ...(config.demo ? [demo] : []),
    ...store.all('SELECT * FROM models WHERE user_id = ? ORDER BY rowid', user(request).id).map(modelView)
  ]);
  route('POST', '/models', async (request, reply) => {
    const account = user(request);
    const value = readModel(request.body);
    if (store.get('SELECT count(*) AS count FROM models WHERE user_id = ?', account.id).count >= 12) throw new PublicError(409, '已达到模型配置上限。');
    const modelId = id();
    store.run('INSERT INTO models VALUES (?, ?, ?, ?, ?, ?)', modelId, account.id, value.name, value.baseUrl, value.model, store.encrypt(value.key, modelId, account.id));
    return reply.code(201).send(modelView(modelRow(modelId, account.id)));
  });
  route('PUT', '/models/:id', async (request) => {
    const account = user(request);
    const row = modelRow(request.params.id, account.id);
    const value = readModel(request.body, row);
    const secret = value.key ? store.encrypt(value.key, row.id, account.id) : row.secret;
    store.run('UPDATE models SET name = ?, base_url = ?, model = ?, secret = ? WHERE id = ?', value.name, value.baseUrl, value.model, secret, row.id);
    return modelView(modelRow(row.id, account.id));
  });
  route('DELETE', '/models/:id', async (request) => {
    const row = modelRow(request.params.id, user(request).id);
    store.run('DELETE FROM models WHERE id = ?', row.id);
    return { ok: true };
  });
  route('POST', '/models/test', async (request) => {
    const account = user(request);
    limit('model-test:' + account.id, 8, 600000);
    const existing = request.body?.id ? modelRow(request.body.id, account.id) : undefined;
    const value = readModel(request.body, existing);
    await completion({ ...value, key: value.key || store.decrypt(existing) }, [{ role: 'user', content: 'Reply OK.' }], 16, { test: true });
    return { ok: true };
  });
  app.get(prefix + '/healthz', async () => ({ ok: true }));
  if (config.assets) {
    if (prefix) app.get(prefix, async (_request, reply) => reply.redirect(prefix + '/'));
    app.get(prefix + '/', async (request, reply) => {
      if (Object.hasOwn(request.query, 'share')) {
        reply.header('X-Robots-Tag', 'noindex, nofollow, noarchive').header('Cache-Control', 'no-store');
      } else reply.header('Cache-Control', 'no-cache');
      return reply.type('text/html; charset=utf-8').send(readFileSync(join(config.assets, 'index.html')));
    });
    app.get(prefix + '/assets/:file', async (request, reply) => {
      const name = request.params.file;
      const type = assetTypes[name.split('.').at(-1)];
      if (!type || !/^[a-z\d_-]+\.[a-z]+$/i.test(name)) return reply.code(404).send();
      try {
        return reply.type(type).header('Cache-Control', 'public, max-age=31536000, immutable').send(readFileSync(join(config.assets, 'assets', name)));
      } catch (error) {
        if (error.code === 'ENOENT') return reply.code(404).send();
        throw error;
      }
    });
  }
  app.addHook('onClose', async () => {
    clearInterval(throttle);
    clearInterval(expiryTimer);
    await Promise.allSettled([...tasks.values()].map(({ task }) => task));
    await Promise.all([preview.close(), sharedPreview.close()]);
    store.db.close();
  });
  return app;
}
