import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { GenerationCheckpointer } from '../server/generation-checkpoints.mjs';
import { openStore } from '../server/storage.mjs';

test('checkpoints reuse writes from a completed sibling when resuming a failed parallel step', async () => {
  const data = await mkdtemp(join(tmpdir(), 'builder-checkpoints-'));
  let store = openStore(data);
  try {
    store.run("INSERT INTO users VALUES ('owner', 'owner', 'test')");
    store.run("INSERT INTO projects VALUES ('project', 'owner', 'project', 1, NULL)");
    store.run("INSERT INTO messages (id, project_id, prompt, model_id, model_name, state, created) VALUES ('message', 'project', 'test', 'platform', 'test', 'running', 1)");
    store.run("INSERT INTO generation_runs (message_id) VALUES ('message')");
    let leftCalls = 0;
    let rightCalls = 0;
    const state = Annotation.Root({ left: Annotation(), right: Annotation() });
    const compile = (interrupted) => new StateGraph(state)
      .addNode('left-worker', () => { leftCalls++; return { left: 'already finished' }; })
      .addNode('right-worker', async () => {
        rightCalls++;
        if (interrupted) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          throw new Error('interrupted sibling');
        }
        return { right: 'finished after resume' };
      })
      .addNode('join', () => ({}))
      .addEdge(START, 'left-worker').addEdge(START, 'right-worker')
      .addEdge(['left-worker', 'right-worker'], 'join').addEdge('join', END)
      .compile({ checkpointer: new GenerationCheckpointer(store, 'message') });
    const config = { configurable: { thread_id: 'message' }, durability: 'sync' };
    await assert.rejects(compile(true).invoke({}, config), /interrupted sibling/);
    store.db.close();
    store = openStore(data);
    const result = await compile(false).invoke(null, config);
    assert.deepEqual(result, { left: 'already finished', right: 'finished after resume' });
    assert.equal(leftCalls, 1);
    assert.equal(rightCalls, 2);
  } finally {
    store.db.close();
    await rm(data, { recursive: true, force: true });
  }
});
