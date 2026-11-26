import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
export const token = () => randomBytes(32).toString('base64url');
const digest = (value) => createHash('sha256').update(value).digest('hex');
export const sessionLifetime = 7 * 24 * 3600;

export async function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return salt + ':' + (await derive(password, salt, 64)).toString('hex');
}

export async function checkPassword(password, stored) {
  const dummy = '0'.repeat(32) + ':' + '0'.repeat(128);
  const reference = Buffer.from(stored ?? dummy);
  const computed = Buffer.from(await hashPassword(password, (stored ?? dummy).split(':')[0]));
  return timingSafeEqual(reference, computed) && Boolean(stored);
}

export function openStore(root, encryptionKey) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!encryptionKey) {
    const path = join(root, 'credential.key');
    try {
      writeFileSync(path, token(), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    encryptionKey = readFileSync(path, 'utf8');
  }
  const key = createHash('sha256').update(encryptionKey).digest();
  const db = new DatabaseSync(join(root, 'platform.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, name TEXT UNIQUE COLLATE NOCASE NOT NULL, password TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL,
      updated INTEGER NOT NULL, active_revision TEXT
    );
    CREATE TABLE IF NOT EXISTS revisions (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      version INTEGER NOT NULL, files TEXT NOT NULL, UNIQUE(project_id, version)
    );
    CREATE TABLE IF NOT EXISTS project_chats (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT, created INTEGER NOT NULL, through_rowid INTEGER, summary TEXT
    );
    CREATE INDEX IF NOT EXISTS project_chat_list ON project_chats(project_id, created);
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      prompt TEXT NOT NULL, model_id TEXT NOT NULL, model_name TEXT NOT NULL, state TEXT NOT NULL,
      response TEXT, created INTEGER NOT NULL, result_type TEXT, agent_progress TEXT, agent_events TEXT
    );
    CREATE TABLE IF NOT EXISTS message_reasoning (
      message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      body TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS generation_runs (
      message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      base_revision TEXT, draft_id TEXT, draft_files TEXT
    );
    CREATE TABLE IF NOT EXISTS research_projects (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS reports (
      message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      html TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS project_memory (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      through_rowid INTEGER NOT NULL, summary TEXT NOT NULL, updated INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_generation ON messages(project_id) WHERE state = 'running';
    CREATE INDEX IF NOT EXISTS message_history ON messages(project_id, created);
    CREATE INDEX IF NOT EXISTS project_owner ON projects(user_id, updated);
    CREATE TABLE IF NOT EXISTS shares (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
      revision_id TEXT NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
      token_hash TEXT UNIQUE NOT NULL, secret TEXT NOT NULL, expires INTEGER NOT NULL,
      initialized INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS share_expiry ON shares(expires);
    CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL,
      base_url TEXT NOT NULL, model TEXT NOT NULL, secret TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS quota (
      day TEXT NOT NULL, subject TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(day, subject)
    );
  `);
  const messageColumns = new Set(db.prepare('PRAGMA table_info(messages)').all().map(({ name }) => name));
  if (!messageColumns.has('result_type')) {
    db.exec('ALTER TABLE messages ADD COLUMN result_type TEXT');
  }
  if (!messageColumns.has('agent_progress')) db.exec('ALTER TABLE messages ADD COLUMN agent_progress TEXT');
  if (!messageColumns.has('agent_events')) db.exec('ALTER TABLE messages ADD COLUMN agent_events TEXT');
  if (!messageColumns.has('chat_id')) db.exec('ALTER TABLE messages ADD COLUMN chat_id TEXT REFERENCES project_chats(id) ON DELETE CASCADE');
  db.exec('CREATE INDEX IF NOT EXISTS chat_message_history ON messages(project_id, chat_id, created)');
  db.prepare(`UPDATE messages SET state = 'failed', agent_progress = NULL, response = CASE WHEN EXISTS (
    SELECT 1 FROM generation_runs WHERE message_id = messages.id AND draft_files IS NOT NULL
  ) THEN ? ELSE ? END WHERE state = 'running'`).run('平台重启中断了生成，可继续修改候选。', '平台重启中断了生成，请重试。');
  const get = (sql, ...params) => db.prepare(sql).get(...params);
  const all = (sql, ...params) => db.prepare(sql).all(...params);
  const run = (sql, ...params) => db.prepare(sql).run(...params);
  return {
    db, get, all, run,
    transaction(action) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const value = action();
        db.exec('COMMIT');
        return value;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    createSession(userId) {
      const value = token();
      run('DELETE FROM sessions WHERE expires <= ?', Date.now());
      run('INSERT INTO sessions VALUES (?, ?, ?)', digest(value), userId, Date.now() + sessionLifetime * 1000);
      return value;
    },
    session(value) {
      if (!value) return undefined;
      return get('SELECT users.id, users.name FROM sessions JOIN users ON users.id = sessions.user_id WHERE token_hash = ? AND expires > ?', digest(value), Date.now());
    },
    endSession(value) {
      if (value) run('DELETE FROM sessions WHERE token_hash = ?', digest(value));
    },
    encrypt(secret, id, owner) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(owner + ':' + id));
      const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
    },
    decrypt(model) {
      const data = Buffer.from(model.secret, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      decipher.setAAD(Buffer.from(model.user_id + ':' + model.id));
      decipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
    }
  };
}

export function cookieValue(header = '', name = 'builder_session') {
  const match = header.match(new RegExp('(?:^|;\\s*)' + name + '=([a-zA-Z0-9_-]{43})(?=;|$)'));
  return match?.[1];
}
