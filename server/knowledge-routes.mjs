import { PublicError } from './models.mjs';
import { knowledgeFileType, knowledgeUploadLimit } from './knowledge.mjs';

const columns = 'id, name, size, created, state, error';

export function registerKnowledgeRoutes(app, { root, store, ownedProject, newId, parser, limit }) {
  const filesPath = root + '/projects/:id/knowledge/files';
  const activeChecks = new Set();

  function library(request) {
    const item = ownedProject(request);
    if (item.kind !== 'knowledge') throw new PublicError(404, '知识库不存在。');
    return item;
  }

  async function updateFile({ id, batch, created, text: fallback }, project) {
    if (activeChecks.has(id)) return;
    const now = Date.now();
    const changed = store.run("UPDATE knowledge_files SET checked = ? WHERE id = ? AND state = 'parsing' AND checked <= ?",
      now, id, now - 5000).changes;
    if (!changed) return;
    activeChecks.add(id);
    try {
      if (now - created > 24 * 3600000) throw new PublicError(422, '解析任务已超时，请重新上传。');
      const text = await parser.check(batch);
      if (text) {
        store.run("UPDATE knowledge_files SET text = ?, state = 'ready', batch = NULL WHERE id = ?", text, id);
        store.run('UPDATE projects SET updated = ? WHERE id = ?', Date.now(), project);
      }
    } catch (error) {
      if (error instanceof PublicError && error.statusCode < 500) {
        if (fallback) {
          store.run("UPDATE knowledge_files SET state = 'ready', batch = NULL WHERE id = ?", id);
          store.run('UPDATE projects SET updated = ? WHERE id = ?', Date.now(), project);
        } else {
          store.run("UPDATE knowledge_files SET state = 'failed', error = ?, batch = NULL WHERE id = ?", error.message, id);
        }
      }
    } finally {
      activeChecks.delete(id);
    }
  }

  app.get(filesPath, async (request) => {
    const project = library(request);
    const pending = store.all("SELECT id, batch, created, text FROM knowledge_files WHERE project_id = ? AND state = 'parsing'", project.id);
    await Promise.all(pending.map((file) => updateFile(file, project.id)));
    return {
      mineru: parser.enabled,
      files: store.all('SELECT ' + columns + ' FROM knowledge_files WHERE project_id = ? ORDER BY created DESC, rowid DESC', project.id)
    };
  });

  app.get(filesPath + '/:file', async (request) => {
    const project = library(request);
    const result = store.get("SELECT id, name, text FROM knowledge_files WHERE id = ? AND project_id = ? AND state = 'ready'",
      request.params.file, project.id);
    if (!result) throw new PublicError(404, '找不到已解析的文件。');
    return result;
  });

  app.delete(filesPath + '/:file', async (request) => {
    const project = library(request);
    store.run('DELETE FROM knowledge_files WHERE id = ? AND project_id = ?', request.params.file, project.id);
    return { ok: true };
  });

  app.register(async (upload) => {
    upload.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
    upload.post(filesPath, {
      bodyLimit: knowledgeUploadLimit,
      onRequest: async (request) => {
        const project = library(request);
        limit('knowledge-upload:' + project.user_id, 24, 3600000);
      }
    }, async (request, reply) => {
      const project = library(request);
      const name = typeof request.query.name === 'string' ? request.query.name.trim() : '';
      if (!name || name.length > 180) throw new PublicError(400, '文件名长度应为 1–180 个字符。');
      knowledgeFileType(name);
      const bytes = request.body;
      if (!Buffer.isBuffer(bytes) || !bytes.length) throw new PublicError(400, '请选择非空文件。');
      const counts = store.get(`SELECT count(*) AS total,
        count(CASE WHEN state IN ('uploading', 'parsing') THEN 1 END) AS pending
        FROM knowledge_files WHERE project_id = ?`, project.id);
      if (counts.total >= 20) throw new PublicError(409, '每个知识库最多保存 20 个文件，请先删除不需要的文件。');
      if (counts.pending >= 3) throw new PublicError(409, '该知识库同时最多解析 3 个文件，请等待已有任务完成。');
      const file = newId();
      store.run("INSERT INTO knowledge_files (id, project_id, name, size, created, state) VALUES (?, ?, ?, ?, ?, 'uploading')",
        file, project.id, name, bytes.length, Date.now());
      try {
        const { batch, text } = await parser.submit(name, bytes);
        store.run('UPDATE knowledge_files SET state = ?, batch = ?, text = ? WHERE id = ?',
          batch ? 'parsing' : 'ready', batch ?? null, text ?? null, file);
        store.run('UPDATE projects SET updated = ? WHERE id = ?', Date.now(), project.id);
        const saved = store.get('SELECT ' + columns + ' FROM knowledge_files WHERE id = ?', file);
        if (!saved) throw new PublicError(404, '知识库或文件已被删除。');
        return reply.code(201).send(saved);
      } catch (error) {
        store.run('DELETE FROM knowledge_files WHERE id = ?', file);
        if (error instanceof PublicError) throw error;
        throw new PublicError(502, '上传或解析服务暂时不可用，请重试。');
      }
    });
  });
}
