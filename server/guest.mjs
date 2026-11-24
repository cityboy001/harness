import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createInterface } from 'node:readline';
import { getQuickJS } from 'quickjs-emscripten';

const engine = await getQuickJS();
const database = new DatabaseSync(process.argv[2]);
database.exec(`
  PRAGMA journal_mode = DELETE;
  PRAGMA max_page_count = 4096;
  CREATE TABLE IF NOT EXISTS records (
    collection TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(collection, id)
  );
`);
const statements = {
  list: database.prepare('SELECT id, value FROM records WHERE collection = ? ORDER BY rowid LIMIT 1000'),
  get: database.prepare('SELECT id, value FROM records WHERE collection = ? AND id = ?'),
  insert: database.prepare('INSERT INTO records VALUES (?, ?, ?)'),
  update: database.prepare('UPDATE records SET value = ? WHERE collection = ? AND id = ?'),
  remove: database.prepare('DELETE FROM records WHERE collection = ? AND id = ?'),
  count: database.prepare('SELECT count(*) AS total FROM records')
};
const toRecord = (row) => row ? { ...JSON.parse(row.value), id: row.id } : null;

function recordData(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object');
  const { id, ...data } = value;
  const json = JSON.stringify(data);
  if (Buffer.byteLength(json) > 8192) throw new Error('Record exceeds storage limit');
  return json;
}

function operate(operation, collection, id, value) {
  if (typeof collection !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/i.test(collection)) throw new Error('Invalid collection');
  if (!['list', 'insert'].includes(operation) && (typeof id !== 'string' || id.length > 64)) throw new Error('Invalid record ID');
  switch (operation) {
    case 'list': {
      const records = [];
      let size = 0;
      for (const row of statements.list.iterate(collection)) {
        size += Buffer.byteLength(row.value);
        if (size > 512000) throw new Error('Collection exceeds response limit');
        records.push(toRecord(row));
      }
      return records;
    }
    case 'get':
      return toRecord(statements.get.get(collection, id));
    case 'insert': {
      if (statements.count.get().total >= 1000) throw new Error('Project record limit reached');
      const newId = randomUUID();
      const data = recordData(id);
      statements.insert.run(collection, newId, data);
      return { ...JSON.parse(data), id: newId };
    }
    case 'update': {
      const row = statements.get.get(collection, id);
      if (!row) return null;
      recordData(value);
      const data = recordData({ ...JSON.parse(row.value), ...value });
      statements.update.run(data, collection, id);
      return { ...JSON.parse(data), id };
    }
    case 'remove':
      return statements.remove.run(collection, id).changes > 0;
    default:
      throw new Error('Unknown database operation');
  }
}

let websiteSource;
function evaluate(source, input) {
  const runtime = engine.newRuntime();
  const deadline = Date.now() + 300;
  runtime.setMemoryLimit(12 * 1024 * 1024);
  runtime.setMaxStackSize(256 * 1024);
  runtime.setInterruptHandler(() => Date.now() > deadline);
  const vm = runtime.newContext();
  let operations = 0;
  let storageError;
  try {
    const bridge = vm.newFunction('storageBridge', (argument) => {
      try {
        if (++operations > 40) throw new Error('Too many database operations');
        if (vm.typeof(argument) !== 'string') throw new Error('Invalid database operation');
        const data = vm.getString(argument);
        if (Buffer.byteLength(data) > 24000) throw new Error('Database request exceeds limit');
        return vm.newString(JSON.stringify({ value: operate(...JSON.parse(data)) }));
      } catch (error) {
        storageError = error.message;
        return vm.newString(JSON.stringify({ error: storageError }));
      }
    });
    vm.setProp(vm.global, '__storage', bridge);
    bridge.dispose();
    const prepare = vm.evalCode(`
      const db = (() => {
        const encode = JSON.stringify.bind(JSON);
        const decode = JSON.parse.bind(JSON);
        const storage = globalThis.__storage;
        delete globalThis.__storage;
        const call = (action, args) => {
          const result = decode(storage(encode([action, ...args])));
          if (result.error) throw new Error(result.error);
          return result.value;
        };
        return Object.freeze({
          list: (...args) => call('list', args), get: (...args) => call('get', args),
          insert: (...args) => call('insert', args), update: (...args) => call('update', args),
          remove: (...args) => call('remove', args)
        });
      })();
      const __encode = JSON.stringify.bind(JSON);
    `);
    if (prepare.error) {
      prepare.error.dispose();
      throw new Error('Unable to prepare guest environment');
    }
    prepare.value.dispose();
    const loaded = vm.evalCode(source, 'server.js');
    if (loaded.error) {
      loaded.error.dispose();
      throw new Error('检查 server.js 时出错。');
    }
    loaded.value.dispose();
    const task = input === undefined
      ? 'typeof handle === "function" && (typeof setup !== "function" || (setup(), true))'
      : '__encode(handle(JSON.parse(' + JSON.stringify(JSON.stringify(input)) + ')))';
    const result = vm.evalCode(task);
    if (result.error) {
      result.error.dispose();
      throw new Error(storageError || '网站后端执行失败或超时。');
    }
    try {
      if (input === undefined) {
        if (!vm.dump(result.value)) throw new Error('生成的后端缺少 handle()。');
        return;
      }
      if (vm.typeof(result.value) !== 'string') throw new Error('后端需要返回 JSON 响应。');
      const json = vm.getString(result.value);
      if (Buffer.byteLength(json) > 512000) throw new Error('网站响应超出大小限制。');
      const response = JSON.parse(json);
      if (!response || !Number.isInteger(response.status) || response.status < 200 || response.status > 599) {
        throw new Error('网站后端返回的状态码无效。');
      }
      return { status: response.status, body: response.body ?? null };
    } finally {
      result.value.dispose();
    }
  } finally {
    vm.dispose();
    runtime.dispose();
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  let output;
  try {
    const command = JSON.parse(line);
    database.exec('BEGIN IMMEDIATE');
    try {
      if (command.type === 'load') {
        if (typeof command.source !== 'string' || Buffer.byteLength(command.source) > 24000) throw new Error('Invalid backend source');
        if (command.setup) evaluate(command.source);
        websiteSource = command.source;
        output = { ok: true };
      } else if (command.type === 'request' && websiteSource) {
        output = { ok: true, response: evaluate(websiteSource, command.input) };
      } else {
        throw new Error('Invalid runner command');
      }
      database.exec(output.response?.status >= 400 ? 'ROLLBACK' : 'COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  } catch (error) {
    output = { ok: false, error: error.message.slice(0, 200) };
  }
  process.stdout.write(JSON.stringify(output) + '\n');
}
database.close();
