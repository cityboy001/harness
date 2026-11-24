import { MemorySaver } from '@langchain/langgraph';
import { deserialize, serialize } from 'node:v8';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const pack = (value) => deflateRawSync(serialize(value));
const unpack = (value) => deserialize(inflateRawSync(value));

// MemorySaver owns the LangGraph serialization and pending-write ordering. Each job has one live saver.
export class GenerationCheckpointer extends MemorySaver {
  constructor(store, threadId) {
    super();
    this.store = store;
    this.threadId = threadId;
    for (const { namespace, checkpoint_id, snapshot, writes } of store.all(
      'SELECT namespace, checkpoint_id, snapshot, writes FROM generation_checkpoints WHERE message_id = ?', threadId)) {
      if (snapshot) {
        this.storage[threadId] ??= Object.create(null);
        this.storage[threadId][namespace] ??= Object.create(null);
        this.storage[threadId][namespace][checkpoint_id] = unpack(snapshot);
      }
      if (writes) this.writes[JSON.stringify([threadId, namespace, checkpoint_id])] = unpack(writes);
    }
  }

  async put(config, checkpoint, metadata) {
    const saved = await super.put(config, checkpoint, metadata);
    const { checkpoint_ns: namespace, checkpoint_id: id } = saved.configurable;
    this.store.run(`INSERT INTO generation_checkpoints (message_id, namespace, checkpoint_id, snapshot) VALUES (?, ?, ?, ?)
      ON CONFLICT(message_id, namespace, checkpoint_id) DO UPDATE SET snapshot = excluded.snapshot`,
    this.threadId, namespace, id, pack(this.storage[this.threadId][namespace][id]));
    return saved;
  }

  async putWrites(config, writes, taskId, taskPath) {
    await super.putWrites(config, writes, taskId, taskPath);
    const { checkpoint_ns: namespace, checkpoint_id: id } = config.configurable;
    this.store.run(`INSERT INTO generation_checkpoints (message_id, namespace, checkpoint_id, writes) VALUES (?, ?, ?, ?)
      ON CONFLICT(message_id, namespace, checkpoint_id) DO UPDATE SET writes = excluded.writes`,
    this.threadId, namespace, id, pack(this.writes[JSON.stringify([this.threadId, namespace, id])]));
  }

  async deleteThread(threadId) {
    await super.deleteThread(threadId);
    this.store.run('DELETE FROM generation_checkpoints WHERE message_id = ?', threadId);
  }
}
