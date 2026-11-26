import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { chromium } from 'playwright-core';
import { createApp } from '../server/app.mjs';
import { showReportCharts } from '../server/report-charts.mjs';
import { cleanReport } from '../server/research.mjs';
import { runResearchCode } from '../server/research-code.mjs';

const sourceUrl = 'https://example.org/research';
const executablePath = process.env.BUILDER_TEST_CHROMIUM;
const toolCall = (name, parameters) => ({
  message: { tool_calls: [{ id: name, type: 'function', function: { name, arguments: JSON.stringify(parameters) } }] }
});

test('existing tables get a preview chart without mixing periods or storing a stale copy', () => {
  const html = '<h1>指标报告</h1><h2>指标对比</h2><table><caption>收入表</caption><thead><tr><th>指标</th>' +
    '<th>2025 年全年</th><th>2025 年前三季度</th><th>2026 年前三季度</th></tr></thead>' +
    '<tbody><tr><th>营业收入</th><td>170 亿元</td><td>100 亿元（+4%）</td><td>120 亿元</td></tr></tbody></table>';
  const visible = showReportCharts(html);
  const chart = visible.slice(visible.indexOf('<figure'), visible.indexOf('</figure>'));
  assert.match(chart, /value="100"[\s\S]*value="120"/);
  assert.doesNotMatch(chart, /2025 年全年|value="170"/);
  assert.ok(visible.indexOf('<figure') < visible.indexOf('<h2>'));
  assert.equal(cleanReport(visible), html);
  assert.match(showReportCharts(cleanReport(visible.replace('120 亿元</td>', '125 亿元</td>'))), /value="125"/);
});

async function fixture(t, { direct = false } = {}) {
  const data = await mkdtemp(join(tmpdir(), 'workbench-research-'));
  const previousReports = [];
  let modelCalls = 0;
  const config = {
    data, origin: 'http://localhost:3000', deepseekKey: 'fixture', dailyUser: 0,
    assets: fileURLToPath(new URL('../dist/', import.meta.url)),
    searchWeb: direct ? false : async () => [{ url: sourceUrl, title: '官方资料', description: '调研来源摘要' }],
    async fetchResearchCodePage(url, { method }) {
      assert.equal(method, 'GET');
      assert.equal(url, sourceUrl);
      return { url, status: 200, body: '[20,22]', contentType: 'application/json', truncated: false };
    },
    readResearchPage: async (url) => {
      assert.equal(url, sourceUrl);
      return { url, text: '来源正文' };
    },
    async completion(_model, messages, _tokens, { tools }) {
      modelCalls++;
      if (messages[1].content.includes('上一份报告引用了什么')) {
        const context = JSON.parse(messages[1].content);
        assert.match(context.previousReport, /官方资料/);
        return '上一份报告引用了官方资料。';
      }
      if (messages[1].content.includes('你上一句说了什么')) {
        const context = JSON.parse(messages[1].content);
        assert.ok(context.recentDialogue.some(({ answer }) => answer === '上一份报告引用了官方资料。'));
        return '我说上一份报告引用了官方资料。';
      }
      assert.deepEqual(tools.map(({ function: fn }) => fn.name), direct ? ['run_code'] : ['search_web', 'read_web_page', 'run_code']);
      const results = messages.filter(({ role }) => role === 'tool');
      if (direct) {
        if (!results.length) return toolCall('run_code', { source: `
          const response = await fetch(${JSON.stringify(sourceUrl)});
          console.log((await response.json()).reduce((sum, n) => sum + n, 0));
        ` });
        assert.equal(JSON.parse(results[0].content).output, '42');
        return '<h1>合计 42</h1><p><a href="' + sourceUrl + '">原始数据</a></p>';
      }
      if (!results.length) {
        previousReports.push(messages[1].content);
        return toolCall('search_web', { query: '查找官方资料' });
      }
      if (results.length === 1) {
        assert.match(results[0].content, /调研来源摘要/);
        return toolCall('read_web_page', { url: sourceUrl });
      }
      assert.match(results[1].content, /来源正文/);
      return '<header class="report-cover unknown-class" onclick="bad()"><h1>调研结论</h1>' +
        '<p class="report-lead">来源已核实。</p></header>' +
        '<section class="report-metrics"><div class="report-metric"><h3>样本</h3><p><strong>42</strong></p></div></section>' +
        '<figure class="report-chart"><figcaption>样本比较</figcaption><div class="report-bar"><p>本期 <strong>42</strong></p>' +
        '<meter min="0" max="50" value="42" aria-label="本期"></meter></div></figure>' +
        '<p>这是用于验证长报告滚动的正文。</p>'.repeat(36) +
        '<a href="' + sourceUrl + '">官方资料</a><script>bad()</script>';
    }
  };
  const app = await createApp(config);
  t.after(async () => {
    await app.close();
    await rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const request = (method, path, payload, cookie) => app.inject({
    method, url: '/api/' + path, payload, headers: { origin: config.origin, ...(cookie && { cookie }) }
  });
  async function register(name) {
    const response = await request('POST', 'register', { name, password: 'test-password' });
    assert.equal(response.statusCode, 201, response.body);
    return response.headers['set-cookie'].split(';')[0];
  }
  return { app, config, previousReports, request, register, modelCalls: () => modelCalls };
}

test('research workspace handles a greeting and contextual follow-ups as ordinary conversation', async t => {
  const { request, register, modelCalls } = await fixture(t);
  const owner = await register('research-chat');
  const project = 'projects/' + (await request('POST', 'projects', { name: '上下文', kind: 'research' }, owner)).json().id;
  async function turn(prompt) {
    const start = await request('POST', project + '/generate', { prompt }, owner);
    assert.equal(start.statusCode, 202, start.body);
    for (let i = 0; i < 100; i++) {
      const { messages } = (await request('GET', project, undefined, owner)).json();
      const row = messages.find(({ id }) => id === start.json().id);
      if (row && row.state !== 'running') return row;
      await delay(20);
    }
    assert.fail('Conversation did not finish');
  }
  const report = await turn('生成调研报告');
  assert.equal(report.result_type, 'report', report.response);
  const before = modelCalls();
  const greeting = await turn('你好！');
  assert.equal(modelCalls(), before);
  for (const reply of [greeting, await turn('上一份报告引用了什么？'), await turn('你上一句说了什么？')]) {
    assert.equal(reply.result_type, 'answer', reply.response);
    assert.ok(reply.response);
    assert.deepEqual(reply.agent_events, []);
  }
});

test('research saves a private, editable report per turn and exports the saved HTML', async (t) => {
  const { request, register, previousReports } = await fixture(t);
  const owner = await register('research-owner');
  const other = await register('research-other');
  const created = await request('POST', 'projects', { name: '行业调研', kind: 'research' }, owner);
  assert.equal(created.statusCode, 201, created.body);
  const project = 'projects/' + created.json().id;
  assert.equal((await request('GET', 'projects', undefined, owner)).json()[0].kind, 'research');

  async function generate(prompt) {
    const response = await request('POST', project + '/generate', { prompt }, owner);
    assert.equal(response.statusCode, 202, response.body);
    const { id } = response.json();
    for (let attempt = 0; attempt < 100; attempt++) {
      const workspace = (await request('GET', project, undefined, owner)).json();
      const turn = workspace.messages.find((item) => item.id === id);
      if (turn && turn.state !== 'running') {
        assert.equal(turn.state, 'complete', turn.response);
        assert.equal(turn.result_type, 'report');
        assert.equal(turn.response, null);
        assert.deepEqual(turn.agent_events.map(({ detail, decision }) => [detail, decision]), [
          ['正在搜索公开网页', '查找官方资料'], ['正在阅读 example.org', undefined]
        ]);
        return project + '/reports/' + id;
      }
      await delay(20);
    }
    assert.fail('Research did not finish');
  }

  const first = await generate('调研行业现状');
  assert.equal((await request('GET', first, undefined, other)).statusCode, 404);
  assert.equal((await request('GET', first + '/download')).statusCode, 401);
  const initial = (await request('GET', first, undefined, owner)).json();
  assert.match(initial.html, /调研结论/);
  assert.match(initial.html, /<header class="report-cover">/);
  assert.match(initial.html, /<meter[^>]+value="42"/);
  assert.doesNotMatch(initial.html, /<script|onclick|unknown-class/);
  const save = { version: initial.version, html: '<h1>修订结论</h1><a href="javascript:alert(1)">异常链接</a>' };
  assert.equal((await request('PATCH', first, save, other)).statusCode, 404);
  const edited = await request('PATCH', first, save, owner);
  assert.equal(edited.statusCode, 200, edited.body);
  assert.doesNotMatch(edited.json().html, /javascript:/);
  assert.equal((await request('PATCH', first, save, owner)).statusCode, 409);
  const second = await generate('补充来源');
  assert.notEqual(second, first);
  assert.match(previousReports[1], /修订结论/);
  assert.match((await request('GET', second, undefined, owner)).json().html, /调研结论/);
  const download = await request('GET', first + '/download', undefined, owner);
  assert.match(download.headers['content-disposition'], /^attachment;.+\.html$/);
  assert.match(download.body, /^<!doctype html>[\s\S]*修订结论/);
});

test('ReAct can calculate from a public API and cite it without a search configuration', async (t) => {
  const { request, register } = await fixture(t, { direct: true });
  const owner = await register('research-direct');
  const project = 'projects/' + (await request('POST', 'projects', { name: 'API 调研', kind: 'research' }, owner)).json().id;
  const started = await request('POST', project + '/generate', { prompt: '读取并汇总 ' + sourceUrl }, owner);
  assert.equal(started.statusCode, 202, started.body);
  const { id } = started.json();
  for (let attempt = 0; attempt < 100; attempt++) {
    const snapshot = (await request('GET', project, undefined, owner)).json();
    assert.equal(snapshot.researchSearchAvailable, false);
    if (snapshot.messages[0].state !== 'running') {
      assert.equal(snapshot.messages[0].state, 'complete', snapshot.messages[0].response);
      assert.deepEqual(snapshot.messages[0].agent_events.map(({ detail }) => detail), [
        '正在执行调研代码…', '正在访问 example.org'
      ]);
      const report = (await request('GET', project + '/reports/' + id, undefined, owner)).json();
      assert.match(report.html, /合计 42/);
      assert.match(report.html, /原始数据/);
      return;
    }
    await delay(20);
  }
  assert.fail('Research code did not finish');
});

test('sandboxed fetch rejects private addresses and methods outside GET and HEAD', async () => {
  const result = await runResearchCode(`
    console.log(typeof process, typeof require);
    const attempts = await Promise.allSettled([
      fetch('https://127.0.0.1/'),
      fetch('https://[::1]/'),
      fetch('https://example.org/', { method: 'POST' })
    ]);
    for (const attempt of attempts) console.log(attempt.reason.message);
  `, new AbortController().signal);
  assert.equal(result.exitCode, 0, result.error);
  assert.match(result.output, /undefined undefined/);
  assert.equal(result.output.match(/公网 IP/g)?.length, 2);
  assert.match(result.output, /GET 和 HEAD/);
  assert.deepEqual(result.sources, []);
});

test('stopping research aborts fetches started inside the sandbox', async () => {
  const controller = new AbortController();
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  let stopped = false;
  const result = runResearchCode('await fetch("https://example.org/");', controller.signal, (_url, { signal }) => {
    markStarted();
    return new Promise((_, reject) => signal.addEventListener('abort', () => {
      stopped = true;
      reject(signal.reason);
    }, { once: true }));
  });
  const rejected = assert.rejects(result, { name: 'AbortError' });
  await Promise.race([started, result]);
  controller.abort();
  await rejected;
  assert.equal(stopped, true);
});

test('the research workspace opens its conversation link, saves edits, and downloads the report in Chromium',
  { skip: !executablePath && 'Set BUILDER_TEST_CHROMIUM to the Chromium executable' }, async (t) => {
    const { app, config } = await fixture(t);
    config.origin = await app.listen({ port: 0, host: '127.0.0.1' });
    const browser = await chromium.launch({ executablePath, headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1250, height: 800 } });
    await page.goto(config.origin);
    await page.getByLabel('用户名').fill('research-browser');
    await page.getByLabel('密码', { exact: true }).fill('test-password');
    await page.getByRole('button', { name: '注册并进入' }).click();
    await page.getByRole('button', { name: '新建调研' }).click();
    await page.getByLabel('项目名称').fill('市场研究');
    await page.getByRole('button', { name: '创建调研' }).click();
    await page.getByLabel('调研主题').fill('调研行业现状');
    await page.getByRole('button', { name: '发送' }).click();
    const reportLink = page.getByRole('link', { name: '查看调研报告' });
    const title = page.getByRole('heading', { name: '调研结论' });
    await title.waitFor();
    assert.equal(await reportLink.getAttribute('aria-current'), 'true');
    assert.equal(await title.evaluate(element => getComputedStyle(element).color), 'rgb(255, 255, 255)');
    assert.equal(await page.locator('.report-bar meter').evaluate(element => element.value), 42);
    const reportViewport = page.getByRole('region', { name: '报告预览' });
    const toolbar = await page.locator('.topbar').boundingBox();
    assert.ok(await reportViewport.evaluate(element => element.scrollHeight > element.clientHeight));
    assert.equal(await page.evaluate(() => document.documentElement.scrollHeight), 800);
    await reportViewport.hover();
    await page.mouse.wheel(0, 650);
    await page.waitForFunction(() => document.querySelector('.report-stage').scrollTop > 0);
    assert.equal(await page.evaluate(() => window.scrollY), 0);
    assert.deepEqual(await page.locator('.topbar').boundingBox(), toolbar);
    await page.locator('.agent-progress > summary').click();
    const searchStep = page.locator('.agent-step').filter({ has: page.locator('summary', { hasText: '正在搜索公开网页' }) });
    assert.equal(await searchStep.locator('p').isVisible(), false);
    await searchStep.locator('summary').click();
    assert.match(await searchStep.locator('p').innerText(), /查找官方资料\n官方资料（example\.org）/);
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    const editor = page.getByRole('textbox', { name: '报告正文' });
    await editor.press('Control+End');
    await editor.press('End');
    await editor.press('Enter');
    await page.keyboard.insertText('已手动更新');
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: '保存并导出 HTML' }).click();
    const download = await downloadEvent;
    assert.match(download.suggestedFilename(), /\.html$/);
    const exported = await readFile(await download.path(), 'utf8');
    assert.match(exported, /已手动更新/);
    assert.match(exported, /\.report-content h1[\s\S]*class="report-content"/);
    assert.match(exported, /<header class="report-cover">[\s\S]*<meter[^>]+value="42"/);
    await page.reload();
    await page.getByText('已手动更新', { exact: false }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await reportViewport.evaluate(element =>
      element.scrollHeight > element.clientHeight && element.clientHeight <= Math.ceil(innerHeight * .7)));
  });
