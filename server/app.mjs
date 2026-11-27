import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { LogController } from 'fastify';
import { chatCompletion, isDeepSeek, parseEndpoint, PublicError, retryModelCompletion } from './models.mjs';
import { buildWebsite, GenerationTimeoutError } from './generation.mjs';
import { makeCodeRunner } from './code-runner.mjs';
import { loadProjectMemory } from './project-memory.mjs';
import { makeBrowserTester } from './browser-tester.mjs';
import { previewInput } from './preview-requests.mjs';
import { checkPassword, cookieValue, hashPassword, openStore, sessionLifetime, token } from './storage.mjs';
import { makePreviews } from './preview.mjs';
import { demoCompletion } from './demo.mjs';
import { cleanReport, quickResearchReply, reportDocument, runResearchTurn } from './research.mjs';
import { showReportCharts } from './report-charts.mjs';
import { deepSeekWebTools } from './web-research.mjs';
import { normalizeDeck } from './ppt-deck.mjs';
import { closePptBrowser } from './ppt-browser.mjs';
import { exportDeckToPdf, exportDeckToPptx } from './ppt-export.mjs';
import { quickPptReply, runPptTurn } from './ppt.mjs';
import { normalizeWordDoc } from './word-doc.mjs';
import { exportWordToDocx, exportWordToPdf } from './word-export.mjs';
import { quickWordReply, runWordTurn } from './word.mjs';
import { answerKnowledge, makeKnowledgeParser } from './knowledge.mjs';
import { registerKnowledgeRoutes } from './knowledge-routes.mjs';
import { makeDocumentParser } from './document-parser.mjs';
import { registerAttachmentRoutes } from './attachments.mjs';

const id = () => randomUUID().replaceAll('-', '');
const dayKey = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const sessionKey = (request) => cookieValue(request.headers.cookie);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const assetTypes = { js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml' };
const selectProjects = `SELECT projects.*, CASE
  WHEN research_projects.project_id IS NOT NULL THEN 'research'
  WHEN ppt_projects.project_id IS NOT NULL THEN 'ppt'
  WHEN word_projects.project_id IS NOT NULL THEN 'word'
  WHEN knowledge_projects.project_id IS NOT NULL THEN 'knowledge'
  ELSE 'website'
END AS kind
  FROM projects
  LEFT JOIN research_projects ON research_projects.project_id = projects.id
  LEFT JOIN ppt_projects ON ppt_projects.project_id = projects.id
  LEFT JOIN word_projects ON word_projects.project_id = projects.id
  LEFT JOIN knowledge_projects ON knowledge_projects.project_id = projects.id`;

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
  let closing = false;
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
    const found = store.get(selectProjects + ' WHERE projects.id = ? AND user_id = ?', projectId, owner);
    if (!found) throw new PublicError(404, '项目不存在。');
    return found;
  }
  const ownedProject = (request) => project(request.params.id, user(request).id);
  function projectChat(projectId, value) {
    if (value == null) return null;
    const chat = field(value, '对话', 64);
    if (!store.get('SELECT id FROM project_chats WHERE id = ? AND project_id = ?', chat, projectId)) {
      throw new PublicError(404, '找不到这条对话。');
    }
    return chat;
  }
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
    id: item.id, name: item.name, kind: item.kind, updated: item.updated, revision: item.active_revision, preview: preview.status(item.id),
    draftRevision: activeDraft(item)?.id ?? null, hasSavedDraft: Boolean(savedDraft(item))
  });
  function activeDraft(item) {
    const draft = draftPreviews.get(item.id);
    return draft && draft.baseRevision === item.active_revision && preview.status(draft.key) === 'running' ? draft : undefined;
  }
  function savedDraft(item) {
    return store.get(`SELECT generation_runs.message_id, draft_id AS id FROM generation_runs
      JOIN messages ON messages.id = generation_runs.message_id
      WHERE messages.project_id = ? AND generation_runs.base_revision IS ? AND draft_id IS NOT NULL
      ORDER BY messages.created DESC, messages.rowid DESC LIMIT 1`, item.id, item.active_revision);
  }
  async function openProjectPreview(item, useDraft, signal) {
    signal?.throwIfAborted();
    if (useDraft || !item.active_revision) {
      const saved = savedDraft(item);
      if (!saved) throw new PublicError(409, '没有可查看的候选预览。');
      const { files } = store.get('SELECT draft_files AS files FROM generation_runs WHERE message_id = ?', saved.message_id);
      if (item.active_revision) await preview.stop(item.id);
      signal?.throwIfAborted();
      await startDraft(item, { ...saved, files }, signal);
    } else {
      const draft = activeDraft(item);
      if (draft) {
        await preview.delete(draft.key, () => [{ id: draft.id }]);
        if (draftPreviews.get(item.id) === draft) draftPreviews.delete(item.id);
      }
      await preview.start(item, () => {
        signal?.throwIfAborted();
        const current = project(item.id, item.user_id);
        return { current, revision: revision(current) };
      }, signal);
    }
    return projectView(project(item.id, item.user_id));
  }

  async function closeProjectPreview(item) {
    const draft = activeDraft(item);
    if (draft) await preview.delete(draft.key, () => [{ id: draft.id }]);
    else await preview.stop(item.id);
    if (draft && draftPreviews.get(item.id) === draft) draftPreviews.delete(item.id);
    return projectView(project(item.id, item.user_id));
  }

  async function startDraft(item, saved, signal) {
    const key = 'draft:' + saved.message_id;
    const draft = { id: saved.id, key, files: saved.files, baseRevision: item.active_revision };
    const current = { ...item, id: key, active_revision: draft.id };
    const previous = draftPreviews.get(item.id);
    if (previous && (previous.key !== key || previous.id !== draft.id)) {
      await preview.delete(previous.key, () => [{ id: previous.id }]);
      if (draftPreviews.get(item.id) === previous) draftPreviews.delete(item.id);
    }
    await preview.start(current, () => ({
      current, revision: draft,
      initialize() {
        signal?.throwIfAborted();
        if (project(item.id, item.user_id).active_revision !== item.active_revision) {
          throw new PublicError(409, '项目版本已更新，请刷新。');
        }
        draftPreviews.set(item.id, draft);
      }
    }), signal);
    return draft;
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
    if (error.statusCode === 413) return reply.code(413).send({ error: '文件或请求内容超过大小限制。' });
    if (error.statusCode && error.statusCode < 500) return reply.code(error.statusCode).send({ error: '请求格式无效。' });
    app.log.error({ name: error.name, code: error.code }, 'Unhandled request error');
    return reply.code(500).send({ error: '服务暂时不可用，请稍后重试。' });
  });
  registerKnowledgeRoutes(app, {
    root: prefix + '/api', store, ownedProject, newId: id, limit,
    parser: makeKnowledgeParser(config.mineruKey, config.mineruFetch)
  });
  registerAttachmentRoutes(app, {
    root: prefix + '/api', store, ownedProject, projectChat, newId: id, limit,
    parser: makeDocumentParser(config.mineruKey, config.mineruFetch)
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
    store.all(selectProjects + ' WHERE user_id = ? ORDER BY updated DESC', user(request).id).map(projectView));
  route('POST', '/projects', async (request, reply) => {
    const owner = user(request).id;
    const name = field(request.body?.name, '项目名称', 60);
    const kind = request.body?.kind ?? 'website';
    if (!['website', 'research', 'ppt', 'word', 'knowledge'].includes(kind)) throw new PublicError(400, '项目类型无效。');
    if (store.get('SELECT count(*) AS count FROM projects WHERE user_id = ?', owner).count >= 30) throw new PublicError(409, '项目数量已达上限。');
    const item = { id: id(), name, kind, user_id: owner, updated: Date.now(), active_revision: null };
    store.transaction(() => {
      store.run('INSERT INTO projects VALUES (?, ?, ?, ?, NULL)', item.id, owner, name, item.updated);
      if (kind === 'research') store.run('INSERT INTO research_projects VALUES (?)', item.id);
      if (kind === 'ppt') store.run('INSERT INTO ppt_projects VALUES (?)', item.id);
      if (kind === 'word') store.run('INSERT INTO word_projects VALUES (?)', item.id);
      if (kind === 'knowledge') store.run('INSERT INTO knowledge_projects VALUES (?)', item.id);
    });
    return reply.code(201).send(projectView(item));
  });
  route('GET', '/projects/:id', async (request) => {
    const item = ownedProject(request);
    const chat = projectChat(item.id, request.query.chat);
    const chats = store.all("SELECT id, coalesce(title, '新对话') AS title FROM project_chats WHERE project_id = ? ORDER BY created DESC, rowid DESC", item.id);
    const activeGeneration = store.get("SELECT id, chat_id, agent_progress FROM messages WHERE project_id = ? AND state = 'running'", item.id) ?? null;
    const records = store.all(`SELECT messages.id, prompt, model_id, model_name, state, response, created, result_type, agent_progress, agent_events,
      message_reasoning.message_id IS NOT NULL AS has_reasoning,
      EXISTS (SELECT 1 FROM generation_runs r
        WHERE r.message_id = messages.id AND r.base_revision IS ? AND r.draft_files IS NOT NULL) AS has_checkpoint FROM messages
      LEFT JOIN message_reasoning ON message_reasoning.message_id = messages.id
      WHERE project_id = ? AND chat_id IS ? ORDER BY created, messages.rowid`, item.active_revision, item.id, chat);
    const attachedRows = item.kind === 'knowledge' ? [] : store.all(
      `SELECT id, message_id, name, size, created, state, error, thumbnail FROM chat_attachments
       WHERE project_id = ? AND chat_id IS ? AND message_id IS NOT NULL
       ORDER BY created ASC, rowid ASC`,
      item.id, chat
    );
    const attachmentsByMessage = new Map();
    for (const row of attachedRows) {
      const { message_id: mid, ...meta } = row;
      const list = attachmentsByMessage.get(mid);
      if (list) list.push(meta);
      else attachmentsByMessage.set(mid, [meta]);
    }
    return { project: projectView(item), chats, activeGeneration, researchSearchAvailable: Boolean(config.searchWeb ?? config.deepseekKey), messages: records.map(({ agent_events, ...record }) => ({
      ...record,
      agent_events: agent_events ? JSON.parse(agent_events) : [],
      attachments: attachmentsByMessage.get(record.id) ?? []
    })) };
  });
  route('POST', '/projects/:id/chats', async (request, reply) => {
    const item = ownedProject(request);
    const chat = { id: id(), title: '新对话' };
    store.run('INSERT INTO project_chats (id, project_id, created) VALUES (?, ?, ?)', chat.id, item.id, Date.now());
    return reply.code(201).send(chat);
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
    const job = running && tasks.get(running.id);
    job?.controller.abort();
    await job?.task;
    const draft = draftPreviews.get(item.id);
    if (draft) {
      draftPreviews.delete(item.id);
      await preview.delete(draft.key, () => [{ id: draft.id }]);
    }
    let shared;
    await preview.delete(item.id, () => {
      ownedProject(request);
      const revisions = store.all(`SELECT id FROM revisions WHERE project_id = ?
        UNION SELECT draft_id AS id FROM generation_runs
        JOIN messages ON messages.id = generation_runs.message_id
        WHERE messages.project_id = ? AND draft_id IS NOT NULL`, item.id, item.id);
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
  function ownedReport(request) {
    const item = ownedProject(request);
    const report = store.get(`SELECT reports.html, reports.version FROM reports JOIN messages ON messages.id = reports.message_id
      WHERE messages.id = ? AND messages.project_id = ?`, request.params.messageId, item.id);
    if (!report) throw new PublicError(404, '找不到该报告。');
    return { item, report };
  }
  const visibleReport = report => ({ ...report, html: showReportCharts(report.html) });
  route('GET', '/projects/:id/reports/:messageId', async (request) => visibleReport(ownedReport(request).report));
  app.route({
    method: 'PATCH', url: prefix + '/api/projects/:id/reports/:messageId', bodyLimit: 500000,
    async handler(request) {
      const { item, report } = ownedReport(request);
      if (request.body?.version !== report.version) throw new PublicError(409, '报告已有更新，请刷新后重新编辑。');
      const html = cleanReport(request.body?.html);
      if (html === report.html) return visibleReport(report);
      store.transaction(() => {
        store.run('UPDATE reports SET html = ?, version = version + 1 WHERE message_id = ?', html, request.params.messageId);
        store.run('UPDATE projects SET updated = ? WHERE id = ?', Date.now(), item.id);
      });
      return visibleReport({ html, version: report.version + 1 });
    }
  });
  route('GET', '/projects/:id/reports/:messageId/download', async (request, reply) => {
    const { item, report } = ownedReport(request);
    const fileName = encodeURIComponent(item.name).replace(/['()*]/g, character => '%' + character.charCodeAt(0).toString(16));
    return reply.type('text/html; charset=utf-8')
      .header('Content-Disposition', "attachment; filename=report.html; filename*=UTF-8''" + fileName + '.html')
      .send(reportDocument(report.html));
  });
  function ownedPptDeck(request) {
    const item = ownedProject(request);
    const row = store.get(`SELECT ppt_decks.deck, ppt_decks.version FROM ppt_decks JOIN messages ON messages.id = ppt_decks.message_id
      WHERE messages.id = ? AND messages.project_id = ?`, request.params.messageId, item.id);
    if (!row) throw new PublicError(404, '找不到该 PPT 演示文稿。');
    return { item, deck: JSON.parse(row.deck), version: row.version };
  }
  route('GET', '/projects/:id/ppt/:messageId', async (request) => {
    const { deck, version } = ownedPptDeck(request);
    return { deck, version };
  });
  app.route({
    method: 'PATCH', url: prefix + '/api/projects/:id/ppt/:messageId', bodyLimit: 700000,
    async handler(request) {
      const { item, deck, version } = ownedPptDeck(request);
      if (request.body?.version !== version) throw new PublicError(409, 'PPT 已有更新，请刷新后重新编辑。');
      const normalized = normalizeDeck(request.body?.deck);
      const serialized = JSON.stringify(normalized);
      if (serialized === JSON.stringify(deck)) return { deck, version };
      store.transaction(() => {
        store.run('UPDATE ppt_decks SET deck = ?, version = version + 1 WHERE message_id = ?', serialized, request.params.messageId);
        store.run('UPDATE projects SET updated = ? WHERE id = ?', Date.now(), item.id);
      });
      return { deck: normalized, version: version + 1 };
    }
  });
  route('GET', '/projects/:id/ppt/:messageId/export', async (request, reply) => {
    const { item, deck } = ownedPptDeck(request);
    const format = request.query?.format === 'pdf' ? 'pdf' : 'pptx';
    const baseName = (deck.title || item.name || 'presentation').trim().slice(0, 80);
    const fileName = encodeURIComponent(baseName).replace(/['()*]/g, character => '%' + character.charCodeAt(0).toString(16));
    if (format === 'pdf') {
      const pdf = await exportDeckToPdf(deck);
      return reply.type('application/pdf')
        .header('Content-Disposition', "attachment; filename=slides.pdf; filename*=UTF-8''" + fileName + '.pdf')
        .send(pdf);
    }
    const pptx = await exportDeckToPptx(deck);
    return reply.type('application/vnd.openxmlformats-officedocument.presentationml.presentation')
      .header('Content-Disposition', "attachment; filename=slides.pptx; filename*=UTF-8''" + fileName + '.pptx')
      .send(pptx);
  });
  function ownedWordDoc(request) {
    const item = ownedProject(request);
    const row = store.get(`SELECT word_docs.doc, word_docs.version FROM word_docs JOIN messages ON messages.id = word_docs.message_id
      WHERE messages.id = ? AND messages.project_id = ?`, request.params.messageId, item.id);
    if (!row) throw new PublicError(404, '找不到该 Word 文档。');
    return { item, doc: JSON.parse(row.doc), version: row.version };
  }
  route('GET', '/projects/:id/word/:messageId', async (request) => {
    const { doc, version } = ownedWordDoc(request);
    return { doc, version };
  });
  app.route({
    method: 'PATCH', url: prefix + '/api/projects/:id/word/:messageId', bodyLimit: 800000,
    async handler(request) {
      const { item, doc, version } = ownedWordDoc(request);
      if (request.body?.version !== version) throw new PublicError(409, 'Word 文档已有更新，请刷新后重新编辑。');
      const normalized = normalizeWordDoc(request.body?.doc);
      const serialized = JSON.stringify(normalized);
      if (serialized === JSON.stringify(doc)) return { doc, version };
      store.transaction(() => {
        store.run('UPDATE word_docs SET doc = ?, version = version + 1 WHERE message_id = ?', serialized, request.params.messageId);
        store.run('UPDATE projects SET updated = ? WHERE id = ?', Date.now(), item.id);
      });
      return { doc: normalized, version: version + 1 };
    }
  });
  route('GET', '/projects/:id/word/:messageId/export', async (request, reply) => {
    const { item, doc } = ownedWordDoc(request);
    const format = request.query?.format === 'pdf' ? 'pdf' : 'docx';
    const baseName = (doc.title || item.name || 'document').trim().slice(0, 80);
    const fileName = encodeURIComponent(baseName).replace(/['()*]/g, character => '%' + character.charCodeAt(0).toString(16));
    if (format === 'pdf') {
      const pdf = await exportWordToPdf(doc);
      return reply.type('application/pdf')
        .header('Content-Disposition', "attachment; filename=document.pdf; filename*=UTF-8''" + fileName + '.pdf')
        .send(pdf);
    }
    const docx = await exportWordToDocx(doc);
    return reply.type('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
      .header('Content-Disposition', "attachment; filename=document.docx; filename*=UTF-8''" + fileName + '.docx')
      .send(docx);
  });
  route('POST', '/projects/:id/generate', async (request, reply) => {
    const item = ownedProject(request);
    const research = item.kind === 'research';
    const ppt = item.kind === 'ppt';
    const word = item.kind === 'word';
    const knowledge = item.kind === 'knowledge';
    const chat = projectChat(item.id, request.body?.chatId);
    const resumeId = request.body?.resumeMessageId == null ? null : field(request.body.resumeMessageId, '生成记录', 64);
    const resume = resumeId && store.get(`SELECT m.*, r.base_revision, r.draft_files FROM messages m JOIN generation_runs r ON r.message_id = m.id
      WHERE m.id = ? AND m.project_id = ? AND m.chat_id IS ? AND m.state IN ('failed', 'stopped')
      AND r.draft_files IS NOT NULL`, resumeId, item.id, chat);
    if (resumeId && (!resume || resume.base_revision !== item.active_revision)) {
      throw new PublicError(409, '当前版本没有可继续的候选。');
    }
    const prompt = resume ? resume.prompt : field(request.body?.prompt, '需求', 6000);
    const quickReply = research ? quickResearchReply(prompt) : ppt ? quickPptReply(prompt) : word ? quickWordReply(prompt) : undefined;
    const modelId = resume ? resume.model_id : field(request.body?.modelId ?? 'platform', '模型', 64);
    if (item.kind !== 'website' && modelId === 'demo') throw new PublicError(400, research ? '请选择支持联网调研的模型。' : '请选择支持对话生成的模型。');
    if (knowledge && !store.get("SELECT id FROM knowledge_files WHERE project_id = ? AND state = 'ready' LIMIT 1", item.id)) {
      throw new PublicError(409, '请先上传文件并等待解析完成。');
    }
    if (!knowledge && !resume && store.get(
      "SELECT id FROM chat_attachments WHERE project_id = ? AND chat_id IS ? AND message_id IS NULL AND state IN ('uploading', 'parsing') LIMIT 1",
      item.id, chat
    )) {
      throw new PublicError(409, '当前对话有文件正在解析中，请等待解析完成后再发送。');
    }
    const model = modelConfig(modelId, item.user_id);
    const web = config.searchWeb === undefined && isDeepSeek(model) ? deepSeekWebTools(model.key) : undefined;
    const search = config.searchWeb ?? web?.search;
    const read = config.readResearchPage ?? web?.read;
    const messageId = resumeId ?? id();
    store.transaction(() => {
      if (store.get("SELECT id FROM messages WHERE project_id = ? AND state = 'running'", item.id)) throw new PublicError(409, '这个项目正在生成，请等待当前请求完成。');
      if (tasks.size >= (config.generationConcurrency ?? 4)) throw new PublicError(503, '生成任务较多，请稍后重试。');
      if (resume) {
        store.run("UPDATE messages SET state = 'running', response = NULL, agent_events = NULL, agent_progress = ? WHERE id = ?", '正在继续修改候选…', messageId);
        store.run('UPDATE projects SET updated = ? WHERE id = ?', Date.now(), item.id);
        return;
      }
      if (!quickReply && modelId === 'platform') {
        quota(item.user_id + ':platform', config.dailyUser ?? 5);
        quota('platform:all', config.dailyGlobal ?? 100);
      } else if (!quickReply) {
        quota(item.user_id + ':' + (modelId === 'demo' ? 'demo' : 'custom'), config.dailyCustom ?? 30);
      }
      const now = Date.now();
      store.run('INSERT INTO messages (id, project_id, chat_id, prompt, model_id, model_name, state, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        messageId, item.id, chat, prompt, modelId, model.name, 'running', now);
      if (!knowledge) {
        // 将本轮待发送的已就绪附件绑定到该条用户消息，发送后从输入框清空
        store.run(
          "UPDATE chat_attachments SET message_id = ? WHERE project_id = ? AND chat_id IS ? AND message_id IS NULL AND state = 'ready'",
          messageId, item.id, chat
        );
      }
      if (modelId !== 'demo' && item.kind === 'website') store.run('INSERT INTO generation_runs (message_id, base_revision) VALUES (?, ?)', messageId, item.active_revision);
      if (chat) store.run('UPDATE project_chats SET title = ? WHERE id = ? AND title IS NULL',
        [...prompt.replace(/\s+/gu, ' ')].slice(0, 32).join(''), chat);
      store.run('UPDATE projects SET updated = ? WHERE id = ?', now, item.id);
    });
    const attachments = knowledge ? [] : store.all(
      "SELECT id, message_id, name, size, text FROM chat_attachments WHERE project_id = ? AND chat_id IS ? AND state = 'ready' ORDER BY created ASC, rowid ASC",
      item.id, chat
    ).map((row) => ({ ...row, currentTurn: row.message_id === messageId }));
    const controller = new AbortController();
    const { signal } = controller;
    const task = (async () => {
      const events = [];
      function recordEvent(event) {
        if (signal.aborted || events.length >= 100) return;
        const index = events.push(event) - 1;
        store.run('UPDATE messages SET agent_events = ? WHERE id = ?', JSON.stringify(events), messageId);
        return (details) => {
          if (signal.aborted || !details) return;
          events[index] = { ...event, details: details.slice(0, 6000) };
          store.run('UPDATE messages SET agent_events = ? WHERE id = ?', JSON.stringify(events), messageId);
        };
      }
      const onActivity = (detail, decision) => recordEvent({ kind: 'activity', detail, decision: decision?.slice(0, 600) });
      const draftController = new AbortController();
      const draftSignal = AbortSignal.any([signal, draftController.signal]);
      let draft;
      let draftStart;
      let previewClosed = false;
      async function discardDraft() {
        draftController.abort();
        await draftStart;
        const active = draftPreviews.get(item.id);
        if (active?.key === 'draft:' + messageId) {
          draftPreviews.delete(item.id);
          draft = active;
        }
        if (draft) {
          await preview.delete(draft.key, () => [{ id: draft.id }]);
          draft = undefined;
        }
      }
      const reasoningLimit = 16000;
      let reasoning = resume ? store.get('SELECT body FROM message_reasoning WHERE message_id = ?', messageId)?.body ?? '' : '';
      let savedReasoning = reasoning;
      let lastReasoningWrite = 0;
      let reasoningTruncated = reasoning.length >= reasoningLimit;
      const flushReasoning = () => {
        const value = reasoningTruncated ? reasoning + '\n\n[其余思考内容已省略]' : reasoning;
        if (value === savedReasoning) return;
        store.run(`INSERT INTO message_reasoning (message_id, body) SELECT id, ? FROM messages WHERE id = ?
          ON CONFLICT(message_id) DO UPDATE SET body = excluded.body`, value, messageId);
        savedReasoning = value;
        lastReasoningWrite = Date.now();
      };
      try {
        if (knowledge) {
          const files = store.all("SELECT name, text FROM knowledge_files WHERE project_id = ? AND state = 'ready' ORDER BY created DESC", item.id);
          const recent = store.all(`SELECT substr(prompt, 1, 700) AS request, substr(response, 1, 900) AS answer FROM messages
            WHERE project_id = ? AND chat_id IS ? AND state = 'complete' ORDER BY created DESC, rowid DESC LIMIT 3`, item.id, chat).reverse();
          store.run('UPDATE messages SET agent_progress = ? WHERE id = ?', '正在查找文件中的相关内容…', messageId);
          const answer = await answerKnowledge({ files, prompt, recent, signal,
            complete: (messages, maxTokens, options) => retryModelCompletion(completion, model, messages, maxTokens, options) });
          signal.throwIfAborted();
          store.transaction(() => {
            store.run("UPDATE messages SET state = 'complete', result_type = 'answer', response = ?, agent_progress = NULL WHERE id = ?", answer, messageId);
            store.run('UPDATE projects SET updated = ? WHERE id = ?', Date.now(), item.id);
          });
          return;
        }
        if (research) {
          const previous = !quickReply && store.all(`SELECT messages.prompt, reports.html FROM reports JOIN messages ON messages.id = reports.message_id
            WHERE project_id = ? AND chat_id IS ? ORDER BY messages.created DESC, messages.rowid DESC LIMIT 6`, item.id, chat)
            .find(report => !quickResearchReply(report.prompt));
          const recent = quickReply ? [] : store.all(`SELECT substr(prompt, 1, 1500) AS request, substr(response, 1, 2000) AS answer,
            result_type AS result FROM messages WHERE project_id = ? AND chat_id IS ? AND state = 'complete'
            ORDER BY created DESC, rowid DESC LIMIT 6`, item.id, chat).reverse();
          const onProgress = (stage) => {
            if (!signal.aborted) store.run("UPDATE messages SET agent_progress = ? WHERE id = ? AND state = 'running'", stage, messageId);
          };
          onProgress('正在理解请求…');
          const result = quickReply ? { type: 'answer', text: quickReply } : await runResearchTurn({
            prompt, previous: previous?.html.slice(0, 24000), recent, attachments, search, read,
            fetchCodePage: config.fetchResearchCodePage, signal, onProgress, onActivity,
            maxTokens: isDeepSeek(model) ? (config.deepseekMaxTokens ?? 64000) : (config.maxTokens ?? 10000),
            completion: (messages, maxTokens, options) => retryModelCompletion(completion, model, messages, maxTokens, options)
          });
          signal.throwIfAborted();
          store.transaction(() => {
            if (result.type === 'report') store.run('INSERT INTO reports (message_id, html) VALUES (?, ?)', messageId, result.html);
            store.run("UPDATE messages SET state = 'complete', result_type = ?, response = ?, agent_progress = NULL WHERE id = ?",
              result.type, result.text ?? null, messageId);
            store.run('UPDATE projects SET updated = ? WHERE id = ?', Date.now(), item.id);
          });
          return;
        }
        if (ppt) {
          const previousRow = !quickReply && store.get(`SELECT ppt_decks.deck FROM ppt_decks JOIN messages ON messages.id = ppt_decks.message_id
            WHERE project_id = ? AND chat_id IS ? ORDER BY messages.created DESC, messages.rowid DESC LIMIT 1`, item.id, chat);
          const previousDeck = previousRow ? JSON.parse(previousRow.deck) : undefined;
          const recent = quickReply ? [] : store.all(`SELECT substr(prompt, 1, 1500) AS request, substr(response, 1, 2000) AS answer,
            result_type AS result FROM messages WHERE project_id = ? AND chat_id IS ? AND state = 'complete'
            ORDER BY created DESC, rowid DESC LIMIT 6`, item.id, chat).reverse();
          const onProgress = (stage) => {
            if (!signal.aborted) store.run("UPDATE messages SET agent_progress = ? WHERE id = ? AND state = 'running'", stage, messageId);
          };
          const onReasoning = (chunk) => {
            if (signal.aborted || !chunk || reasoningTruncated) return;
            const remain = reasoningLimit - reasoning.length;
            if (chunk.length > remain) {
              reasoning += chunk.slice(0, remain);
              reasoningTruncated = true;
            } else {
              reasoning += chunk;
            }
            if (reasoningTruncated || Date.now() - lastReasoningWrite >= 400) flushReasoning();
          };
          onProgress('正在规划 PPT 结构与视觉主题…');
          const result = quickReply ? { type: 'answer', text: quickReply } : await runPptTurn({
            prompt, previousDeck, recent, attachments, search, read, signal, onProgress, onActivity, onReasoning,
            maxTokens: isDeepSeek(model) ? (config.deepseekMaxTokens ?? 64000) : (config.maxTokens ?? 10000),
            completion: (messages, maxTokens, options) => retryModelCompletion(completion, model, messages, maxTokens, options)
          });
          flushReasoning();
          signal.throwIfAborted();
          store.transaction(() => {
            if (result.type === 'ppt') store.run('INSERT INTO ppt_decks (message_id, deck) VALUES (?, ?)', messageId, JSON.stringify(result.deck));
            store.run("UPDATE messages SET state = 'complete', result_type = ?, response = ?, agent_progress = NULL WHERE id = ?",
              result.type, result.type === 'ppt' ? result.summary : result.text ?? null, messageId);
            store.run('UPDATE projects SET updated = ? WHERE id = ?', Date.now(), item.id);
          });
          return;
        }
        if (word) {
          const previousRow = !quickReply && store.get(`SELECT word_docs.doc FROM word_docs JOIN messages ON messages.id = word_docs.message_id
            WHERE project_id = ? AND chat_id IS ? ORDER BY messages.created DESC, messages.rowid DESC LIMIT 1`, item.id, chat);
          const previousDoc = previousRow ? JSON.parse(previousRow.doc) : undefined;
          const recent = quickReply ? [] : store.all(`SELECT substr(prompt, 1, 1500) AS request, substr(response, 1, 2000) AS answer,
            result_type AS result FROM messages WHERE project_id = ? AND chat_id IS ? AND state = 'complete'
            ORDER BY created DESC, rowid DESC LIMIT 6`, item.id, chat).reverse();
          const onProgress = (stage) => {
            if (!signal.aborted) store.run("UPDATE messages SET agent_progress = ? WHERE id = ? AND state = 'running'", stage, messageId);
          };
          const onReasoning = (chunk) => {
            if (signal.aborted || !chunk || reasoningTruncated) return;
            const remain = reasoningLimit - reasoning.length;
            if (chunk.length > remain) {
              reasoning += chunk.slice(0, remain);
              reasoningTruncated = true;
            } else {
              reasoning += chunk;
            }
            if (reasoningTruncated || Date.now() - lastReasoningWrite >= 400) flushReasoning();
          };
          onProgress('正在规划 Word 文档结构与样式…');
          const result = quickReply ? { type: 'answer', text: quickReply } : await runWordTurn({
            prompt, previousDoc, recent, attachments, search, read, signal, onProgress, onActivity, onReasoning,
            maxTokens: isDeepSeek(model) ? (config.deepseekMaxTokens ?? 64000) : (config.maxTokens ?? 10000),
            completion: (messages, maxTokens, options) => retryModelCompletion(completion, model, messages, maxTokens, options)
          });
          flushReasoning();
          signal.throwIfAborted();
          store.transaction(() => {
            if (result.type === 'word') store.run('INSERT INTO word_docs (message_id, doc) VALUES (?, ?)', messageId, JSON.stringify(result.doc));
            store.run("UPDATE messages SET state = 'complete', result_type = ?, response = ?, agent_progress = NULL WHERE id = ?",
              result.type, result.type === 'word' ? result.summary : result.text ?? null, messageId);
            store.run('UPDATE projects SET updated = ? WHERE id = ?', Date.now(), item.id);
          });
          return;
        }
        const setBuildProgress = (stage) => {
          if (signal.aborted) return;
          store.run("UPDATE messages SET agent_progress = ? WHERE id = ? AND state = 'running'", stage || null, messageId);
        };
        const prior = item.active_revision ? revision(item) : undefined;
        const baseline = prior ? JSON.parse(prior.files) : undefined;
        const previousAttempt = resume ? { state: resume.state, response: resume.response } : modelId === 'demo' ? undefined : store.get(`
          SELECT state, substr(response, 1, 1200) AS response FROM messages
          WHERE project_id = ? AND chat_id IS ? AND prompt = ? AND state IN ('failed', 'stopped')
          ORDER BY created DESC LIMIT 1`, item.id, chat, prompt);
        if (modelId !== 'demo') setBuildProgress('正在整理项目上下文…');
        const memory = modelId === 'demo' ? undefined : await loadProjectMemory(store, item.id, model, completion, (error) => {
          app.log.warn({ project: item.id, name: error.name, code: error.code }, 'Could not update project memory');
        }, signal, chat);
        signal.throwIfAborted();
        const draftFiles = resume ? JSON.parse(resume.draft_files) : undefined;
        const context = previousAttempt?.response
          ? '\n\n上次执行结果（供参考）：' + previousAttempt.response.slice(0, 1200)
          : '';
        const request = prompt + (draftFiles ? '\n\n当前文件是上次保存的未发布候选。继续完成原需求；若已完成修改，提交空 changes 以重新检查该候选。' : '') + context;
        let modelTurns = 0;
        const provider = modelId === 'demo' ? demoCompletion : (model, messages, maxTokens, options) => {
          const stage = ++modelTurns === 1 ? '正在等待模型返回首个结果…' : '正在等待模型返回下一步结果…';
          setBuildProgress(stage);
          if (modelTurns === 1) recordEvent({ kind: 'progress', detail: stage });
          return retryModelCompletion(completion, model, messages, maxTokens, options, (attempt, reason) => {
            const detail = `正在第 ${attempt} 次重试模型请求…`;
            setBuildProgress(detail);
            onActivity(detail, reason);
          });
        };
        const output = await buildWebsite(model, request, draftFiles ?? baseline, provider, {
            memory, attachments, signal, timeoutMs: config.generationTimeoutMs, react: true, runCode: makeCodeRunner(config.codeLauncher),
            search, readWebPage: read,
            testBrowser, requireBrowser: Boolean(testBrowser) && modelId !== 'demo',
            resumeDraft: Boolean(draftFiles), comparisonFiles: baseline ?? null,
            async controlPreview(action, useDraft, toolSignal) {
              await draftStart;
              toolSignal.throwIfAborted();
              const current = project(item.id, item.user_id);
              const view = action === 'open'
                ? await openProjectPreview(current, useDraft, toolSignal)
                : await closeProjectPreview(current);
              previewClosed = action === 'close';
              return { status: view.draftRevision ? 'running' : view.preview,
                version: view.draftRevision ? 'draft' : view.revision ? 'published' : null };
            },
            onCandidate(files) {
              if (draftSignal.aborted) return;
              const candidate = { id: id(), message_id: messageId, files: JSON.stringify(files) };
              store.run('UPDATE generation_runs SET draft_id = ?, draft_files = ? WHERE message_id = ? AND draft_files IS NOT ?',
                candidate.id, candidate.files, messageId, candidate.files);
              if (previewClosed || item.active_revision || draftStart || activeDraft(item)) return;
              const saved = store.get('SELECT message_id, draft_id AS id, draft_files AS files FROM generation_runs WHERE message_id = ?', messageId);
              draftStart = startDraft(item, saved, draftSignal).then((value) => { draft = value; }).catch((error) => {
                if (!(error instanceof PublicError) && !draftSignal.aborted) app.log.warn({ name: error.name }, 'Could not start draft preview');
              }).finally(() => { if (!draft) draftStart = undefined; });
            },
            maxTokens: isDeepSeek(model)
              ? (config.deepseekMaxTokens ?? 64000)
              : (config.maxTokens ?? 10000),
            onProgress(stage) {
              if (signal.aborted) return;
              setBuildProgress(stage);
              if (stage) return recordEvent({ kind: 'progress', detail: stage });
            },
            onActivity({ detail, decision }) {
              return onActivity(detail, decision);
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
          const saved = store.get('SELECT draft_id FROM generation_runs WHERE message_id = ?', messageId);
          if (saved?.draft_id) throw new PublicError(422, '本轮未提交已验证的版本，已保留候选。\n\n' + output.summary);
          store.transaction(() => {
            store.run("UPDATE messages SET state = 'complete', result_type = 'answer', response = ?, agent_progress = NULL WHERE id = ?", output.summary, messageId);
            store.run('DELETE FROM generation_runs WHERE message_id = ?', messageId);
          });
          return;
        }
        const active = project(item.id, item.user_id);
        if (active.active_revision !== item.active_revision) throw new PublicError(409, '项目版本已变化，请重新提交修改。');
        const next = id();
        if (modelId !== 'demo') setBuildProgress('正在启用验收后的版本…');
        await preview.activate(active, next, output.files, () => store.transaction(() => {
          signal.throwIfAborted();
          if (project(item.id, item.user_id).active_revision !== item.active_revision) {
            throw new PublicError(409, '项目版本已变化，请重新提交修改。');
          }
          store.run('INSERT INTO revisions VALUES (?, ?, ?, ?)', next, item.id, (prior?.version ?? 0) + 1, JSON.stringify(output.files));
          store.run('UPDATE projects SET active_revision = ?, updated = ? WHERE id = ?', next, Date.now(), item.id);
          store.run("UPDATE messages SET state = 'complete', result_type = 'revision', response = ?, agent_progress = NULL WHERE id = ?", output.summary, messageId);
          store.run('DELETE FROM generation_runs WHERE message_id = ?', messageId);
        }), signal, !previewClosed);
      } catch (error) {
        flushReasoning();
        if (signal.aborted) {
          store.run("UPDATE messages SET state = ?, agent_progress = NULL, response = ? WHERE id = ?",
            closing ? 'failed' : 'stopped', closing
              ? (research ? '平台重启中断了调研，请重试。' : '平台重启中断了生成。可继续修改已保存的候选。')
              : '已停止生成。', messageId);
          return;
        }
        const timedOut = error instanceof GenerationTimeoutError;
        const unexpected = !(error instanceof PublicError);
        let response = unexpected ? '生成遇到平台内部错误，请稍后重试。' : error.message;
        if (timedOut || unexpected) {
          const stage = store.get('SELECT agent_progress FROM messages WHERE id = ?', messageId)?.agent_progress;
          const candidate = !research && Boolean(store.get(
            'SELECT draft_id FROM generation_runs WHERE message_id = ? AND draft_files IS NOT NULL', messageId)?.draft_id);
          if (stage) response += '\n中断时，' + stage;
          if (!research) response += candidate ? '\n已保存未发布的候选，可预览或继续修改。' : '\n本轮尚未保存候选文件。';
          const context = { project: item.id, messageId, stage, candidate, code: error.code, name: error.name };
          if (timedOut) app.log.warn(context, 'Generation timed out');
          else app.log.error(context, 'Generation failed');
        }
        store.run("UPDATE messages SET state = 'failed', response = ?, agent_progress = NULL WHERE id = ?", response, messageId);
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
  route('POST', '/projects/:id/preview/start', async (request) =>
    openProjectPreview(ownedProject(request), request.body?.draft === true));
  route('POST', '/projects/:id/preview/stop', async (request) =>
    closeProjectPreview(ownedProject(request)));
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
    await completion({ ...value, key: value.key || store.decrypt(existing) }, [{ role: 'user', content: '只回复「连接成功」。' }], 16, { test: true });
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
    closing = true;
    clearInterval(throttle);
    clearInterval(expiryTimer);
    for (const { controller } of tasks.values()) controller.abort();
    await Promise.allSettled([...tasks.values()].map(({ task }) => task));
    await Promise.all([preview.close(), sharedPreview.close(), closePptBrowser()]);
    store.db.close();
  });
  return app;
}
