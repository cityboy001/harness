import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildWebsite } from '../server/generation.mjs';
import { loadProjectMemory } from '../server/project-memory.mjs';
import { openStore } from '../server/storage.mjs';

const model = { platform: true };
const baseline = {
  'index.html': '<h1>Site</h1>',
  'server.js': 'function handle(){return {status:200,body:[]}}'
};

test('aged requirements survive in SQLite and the model can look up exact original turns', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'builder-memory-'));
  let store = openStore(dir);
  const summary = { requirements: ['Default order: newest first.'], interfaces: [], decisions: [], pending: [] };
  try {
    store.run('INSERT INTO users VALUES (?, ?, ?)', 'owner', 'owner', 'fixture');
    store.run('INSERT INTO projects VALUES (?, ?, ?, ?, NULL)', 'project-a', 'owner', 'a', Date.now());
    store.run('INSERT INTO projects VALUES (?, ?, ?, ?, NULL)', 'project-b', 'owner', 'b', Date.now());
    const add = (project, number, request, reply = '收到。', state = 'complete') =>
      store.run('INSERT INTO messages (id,project_id,prompt,model_id,model_name,state,response,created) VALUES (?,?,?,?,?,?,?,?)',
        number.toString(16).padStart(32, '0'), project, request, 'platform', 'DeepSeek', state, reply, number);
    add('project-a', 1, 'Remember: default order must be newest first.', 'I will preserve the ordering.');
    const longRequest = 'Intro '.repeat(420) + 'The original acceptance detail is record AC-31.';
    add('project-a', 2, longRequest);
    add('project-b', 20, 'Other project acceptance detail is PRIVATE-B.');
    for (let index = 3; index <= 5; index++) add('project-a', index, 'Newer turn ' + index);
    const recommendation = 'Recommended: cart badge, search filters, and order detail with cancellation.';
    const proposal = 'Feature menu. ' + 'Other proposals. '.repeat(150) + recommendation;
    add('project-a', 6, 'Newer turn 6', proposal);
    add('project-a', 7, 'Current unfinished request', null, 'running');
    const memory = await loadProjectMemory(store, 'project-a', model, async (_model, messages) => {
      const context = JSON.parse(messages[1].content);
      assert.equal(context.turns[0].request, 'Remember: default order must be newest first.');
      assert.ok(longRequest.startsWith(context.turns[1].request.slice(0, -1)));
      return JSON.stringify(summary);
    });
    assert.deepEqual(memory.context.summary, summary);
    assert.equal(memory.context.recent.length, 4);
    assert.ok(memory.context.recent.at(-1).reply.endsWith(recommendation));
    assert.equal(memory.context.recent.at(-1).reply.length, 850);
    assert.ok(!JSON.stringify(memory.context.recent).includes('newest first'));
    assert.match(JSON.stringify(store.get('SELECT summary FROM project_memory WHERE project_id = ?', 'project-a')), /newest first/);
    store.db.close();
    store = openStore(dir);
    store.run('DELETE FROM messages WHERE id = ?', '7'.padStart(32, '0'));
    const restored = await loadProjectMemory(store, 'project-a', model, async () => {
      assert.fail('Previously summarized turns must not be summarized again');
    });
    const foreign = JSON.parse(restored.lookup({ query: 'PRIVATE-B' }));
    assert.deepEqual(foreign.matches, []);
    let calls = 0;
    const answer = await buildWebsite(model, 'What ordering and original acceptance detail did we set?', baseline, async (_model, messages, _budget, options) => {
      calls++;
      if (calls === 1) {
        assert.match(messages[1].content, /newest first/);
        assert.match(messages[1].content, /Newer turn 6/);
        assert.ok(!messages[1].content.includes('AC-31'));
        assert.ok(options.tools.some(({ function: tool }) => tool.name === 'search_project_history'));
        return { message: { tool_calls: [{
          id: 'history-1', type: 'function', function: { name: 'search_project_history', arguments: '{"query":"acceptance detail"}' }
        }] } };
      }
      assert.match(messages.at(-1).content, /AC-31/);
      assert.ok(!messages.at(-1).content.includes('PRIVATE-B'));
      return '{"answer":"Newest first; original record AC-31."}';
    }, { maxTokens: 32000, memory: restored });
    assert.deepEqual(answer, { files: null, summary: 'Newest first; original record AC-31.' });
    const exact = JSON.parse(restored.lookup({ turnId: '2'.padStart(32, '0') }));
    assert.equal(exact.matches[0].request, longRequest);
    add('project-a', 8, 'Latest correction: default order is now oldest first.');
    add('project-a', 9, 'Subsequent question');
    add('project-a', 10, 'Another subsequent question');
    add('project-a', 11, 'Later turn');
    add('project-a', 12, 'Most recent turn');
    const next = await loadProjectMemory(store, 'project-a', model, async (_model, messages) => {
      const context = JSON.parse(messages[1].content);
      assert.deepEqual(context.summary, summary);
      assert.ok(context.turns.some((turn) => turn.request.includes('oldest first')));
      return JSON.stringify({ ...summary, requirements: ['Default order: oldest first.'] });
    });
    assert.deepEqual(next.context.summary.requirements, ['Default order: oldest first.']);
  } finally {
    store.db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
