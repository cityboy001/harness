import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';
import { PublicError } from './models.mjs';
import { SLIDE_HEIGHT, SLIDE_WIDTH } from './ppt-deck.mjs';

const CANDIDATE_BROWSERS = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
];

export function resolvePptBrowserExecutable() {
  for (const candidate of CANDIDATE_BROWSERS) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  const bundled = chromium.executablePath();
  if (bundled && existsSync(bundled)) return bundled;
  throw new PublicError(503, '服务器未找到可用的 Chromium/Chrome 浏览器，无法执行 PPT 排版检查或导出。');
}

let sharedBrowser = null;
let launching = null;
let idleTimer = null;
let queue = Promise.resolve();
const IDLE_CLOSE_MS = 90_000;

function scheduleIdleClose() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    void closePptBrowser();
  }, IDLE_CLOSE_MS);
  idleTimer.unref?.();
}

async function getBrowser() {
  if (sharedBrowser?.isConnected()) {
    scheduleIdleClose();
    return sharedBrowser;
  }
  if (!launching) {
    const executablePath = resolvePptBrowserExecutable();
    const tempDir = tmpdir();
    launching = chromium.launch({
      executablePath,
      headless: true,
      timeout: 15000,
      env: { ...process.env, HOME: tempDir, XDG_CONFIG_HOME: tempDir, XDG_CACHE_HOME: tempDir },
      args: ['--disable-dev-shm-usage', '--no-sandbox']
    }).then((browser) => {
      sharedBrowser = browser;
      browser.on('disconnected', () => {
        if (sharedBrowser === browser) sharedBrowser = null;
      });
      scheduleIdleClose();
      return browser;
    }).finally(() => {
      launching = null;
    });
  }
  return launching;
}

export async function closePptBrowser() {
  clearTimeout(idleTimer);
  idleTimer = null;
  const current = sharedBrowser;
  sharedBrowser = null;
  if (current) {
    await current.close().catch(() => {});
  }
}

// 串行执行 Playwright 页面任务，避免并发占用过多内存并禁用外部网络请求
export function withPptPage(action, { deviceScaleFactor = 2, viewport = { width: SLIDE_WIDTH, height: SLIDE_HEIGHT }, signal } = {}) {
  const run = async () => {
    signal?.throwIfAborted();
    const browser = await getBrowser();
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor
    });
    const page = await context.newPage();
    await page.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith('data:') || url === 'about:blank') return route.continue();
      return route.abort();
    });
    try {
      return await action(page);
    } finally {
      await context.close().catch(() => {});
      scheduleIdleClose();
    }
  };
  const job = queue.then(run, run);
  queue = job.catch(() => {});
  return job;
}
