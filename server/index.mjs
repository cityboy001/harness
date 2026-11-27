import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createApp } from './app.mjs';

const env = process.env;
function number(name, fallback, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  const raw = env[name];
  const value = Number(raw ?? fallback);
  if (raw?.trim() === '' || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error('Invalid setting: ' + name);
  return value;
}
const port = number('PORT', 3000);
const origin = new URL(env.APP_ORIGIN ?? 'http://localhost:' + port).origin;
const basePath = env.BASE_PATH ?? '';
if (basePath && !/^\/[a-z0-9-]+$/.test(basePath)) throw new Error('Invalid BASE_PATH');
if (origin.startsWith('https:') && !env.PREVIEW_LAUNCHER) throw new Error('Set PREVIEW_LAUNCHER for HTTPS deployment.');
const app = await createApp({
  origin, basePath,
  data: resolve(env.DATA_DIR ?? '.builder-data'),
  assets: fileURLToPath(new URL('../dist/', import.meta.url)),
  logger: true,
  deepseekKey: env.DEEPSEEK_API_KEY?.trim(),
  mineruKey: env.MINERU_API_KEY?.trim(),
  deepseekModel: env.DEEPSEEK_MODEL?.trim(),
  encryptionKey: env.CREDENTIAL_KEY,
  launcher: env.PREVIEW_LAUNCHER,
  codeLauncher: env.CODE_LAUNCHER,
  browserLauncher: env.BROWSER_TEST_LAUNCHER,
  demo: env.BUILDER_DEMO === '1',
  maxTokens: number('MODEL_MAX_TOKENS', 10000),
  deepseekMaxTokens: number('DEEPSEEK_MAX_TOKENS', 64000),
  generationTimeoutMs: number('GENERATION_TIMEOUT_MS', 0, 0, 2147483647),
  dailyUser: number('PLATFORM_USER_DAILY_LIMIT', 5, 0),
  dailyGlobal: number('PLATFORM_DAILY_LIMIT', 100, 0),
  dailyCustom: number('CUSTOM_USER_DAILY_LIMIT', 30, 0),
  maxPreviews: number('MAX_PREVIEWS', 2),
  idleMs: number('PREVIEW_IDLE_MS', 900000),
  generationConcurrency: number('GENERATION_CONCURRENCY', 4)
});
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
await app.listen({ port, host: '127.0.0.1' });
