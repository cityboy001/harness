import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import JSZip from 'jszip';
import { Document, Packer, Paragraph } from 'docx';
import { createApp } from '../server/app.mjs';

test('a private knowledge project imports text and MinerU files and cites relevant excerpts', async (t) => {
  const data = await mkdtemp(join(tmpdir(), 'workbench-knowledge-'));
  const origin = 'http://localhost:3000';
  const zip = new JSZip();
  zip.file('result/full.md', '季度收入 172 万元。');
  const archive = await zip.generateAsync({ type: 'nodebuffer' });
  zip.file('result/full.md', ' ');
  const blankArchive = await zip.generateAsync({ type: 'nodebuffer' });
  const app = await createApp({
    data, origin, deepseekKey: 'fixture-model', mineruKey: 'fixture-parser',
    async mineruFetch(input, options) {
      const url = new URL(input);
      if (url.hostname === 'mineru.net') {
        assert.equal(options.headers.Authorization, 'Bearer fixture-parser');
        if (url.pathname.endsWith('/file-urls/batch')) {
          const file = JSON.parse(options.body).files[0];
          assert.ok(['经营简报.pdf', '采购要求.docx'].includes(file.name));
          const type = file.name.endsWith('.pdf') ? 'pdf' : 'word';
          assert.equal(file.is_ocr, type === 'pdf');
          return Response.json({ code: 0, data: { batch_id: type, file_urls: ['https://mineru.oss-cn-shanghai.aliyuncs.com/' + type] } });
        }
        const type = url.pathname.split('/').at(-1);
        assert.ok(['pdf', 'word'].includes(type));
        return Response.json({ code: 0, data: { extract_result: [{ state: 'done', full_zip_url: 'https://cdn-mineru.openxlab.org.cn/' + type + '.zip' }] } });
      }
      assert.equal(options.headers, undefined);
      if (options.method === 'PUT') {
        if (url.pathname === '/pdf') assert.deepEqual(options.body, Buffer.from('synthetic PDF'));
        return new Response(null);
      }
      return new Response(url.pathname === '/pdf.zip' ? archive : blankArchive);
    },
    async completion(_model, messages) {
      const input = JSON.parse(messages[1].content);
      assert.equal(input.sources[0].name, '经营简报.pdf');
      assert.match(input.sources[0].excerpt, /172 万元/);
      return '季度收入 172 万元。[1]';
    }
  });
  t.after(async () => {
    await app.close();
    await rm(data, { recursive: true, force: true });
  });
  const request = (method, path, payload, cookie, headers) =>
    app.inject({ method, url: '/api' + path, payload, headers: { origin, ...(cookie && { cookie }), ...headers } });
  const register = async (name) => {
    const response = await request('POST', '/register', { name, password: 'test-password' });
    assert.equal(response.statusCode, 201);
    return response.headers['set-cookie'].split(';')[0];
  };
  const owner = await register('knowledge-owner');
  const outsider = await register('knowledge-outsider');
  const created = await request('POST', '/projects', { name: '业务资料', kind: 'knowledge' }, owner);
  assert.equal(created.statusCode, 201);
  const project = '/projects/' + created.json().id;
  const files = project + '/knowledge/files';
  const upload = (name, text, cookie = owner) => request('POST', files + '?name=' + encodeURIComponent(name),
    Buffer.from(text), cookie, { 'Content-Type': 'application/octet-stream' });
  assert.equal((await request('GET', files, undefined, outsider)).statusCode, 404);
  assert.equal((await upload('无权上传.txt', '资料', outsider)).statusCode, 404);
  assert.equal((await upload('格式不支持.exe', '资料')).statusCode, 400);
  assert.equal((await request('POST', project + '/generate', { prompt: '收入多少？' }, owner)).statusCode, 409);
  const text = await upload('团队成员.txt', '小赵、小陈和小林。');
  assert.equal(text.statusCode, 201, text.body);
  assert.equal(text.json().state, 'ready');
  const pdf = await upload('经营简报.pdf', 'synthetic PDF');
  assert.equal(pdf.statusCode, 201, pdf.body);
  assert.equal(pdf.json().state, 'parsing');
  const listed = await request('GET', files, undefined, owner);
  assert.equal(listed.json().files.find(file => file.id === pdf.json().id).state, 'ready');
  const content = await request('GET', files + '/' + pdf.json().id, undefined, owner);
  assert.match(content.json().text, /172 万元/);
  assert.equal((await request('GET', files + '/' + pdf.json().id, undefined, outsider)).statusCode, 404);
  const answer = await request('POST', project + '/generate', { prompt: '季度收入多少？' }, owner);
  assert.equal(answer.statusCode, 202, answer.body);
  let turn;
  for (let i = 0; i < 30; i++) {
    const workspace = await request('GET', project, undefined, owner);
    turn = workspace.json().messages.find(row => row.id === answer.json().id);
    if (turn && turn.state !== 'running') break;
    await wait(20);
  }
  assert.equal(turn?.state, 'complete');
  assert.match(turn.response, /来源\n\[1\] 经营简报\.pdf\n季度收入 172 万元/);
  assert.equal((await request('DELETE', files + '/' + pdf.json().id, undefined, owner)).statusCode, 200);
  assert.equal((await request('GET', files + '/' + pdf.json().id, undefined, owner)).statusCode, 404);
  const docx = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('采购上限为 532 元。')] }] }));
  const word = await upload('采购要求.docx', docx);
  assert.equal(word.statusCode, 201, word.body);
  assert.equal(word.json().state, 'parsing');
  assert.equal((await request('GET', files, undefined, owner)).json().files.find(file => file.id === word.json().id).state, 'ready');
  assert.match((await request('GET', files + '/' + word.json().id, undefined, owner)).json().text, /532 元/);
});
