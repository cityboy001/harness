import { copyFile, mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

const state = '/var/lib/ai-site-builder';
const directory = '/var/backups/ai-site-builder';

async function snapshot(source, destination) {
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    await backup(db, destination);
  } finally {
    db.close();
  }
}

async function capture(target) {
  const platform = join(target, 'platform.sqlite');
  await snapshot(join(state, 'platform.sqlite'), platform);
  const catalog = new DatabaseSync(platform, { readOnly: true });
  let projects;
  try {
    projects = catalog.prepare(`SELECT active_revision FROM projects WHERE active_revision IS NOT NULL
      UNION ALL SELECT id AS active_revision FROM shares WHERE initialized = 1 AND expires > ?`).all(Date.now());
  } finally {
    catalog.close();
  }
  for (const { active_revision: revision } of projects) {
    if (!/^[0-9a-f]{32}$/.test(revision)) throw new Error('Invalid project database ID');
    const subfolder = join('previews', revision);
    await mkdir(join(target, subfolder), { recursive: true });
    await snapshot(join(state, subfolder, 'data.sqlite'), join(target, subfolder, 'data.sqlite'));
  }
  await copyFile(join(state, 'credential.key'), join(target, 'credential.key')).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

await mkdir(directory, { recursive: true, mode: 0o700 });
for (let attempt = 1; ; attempt++) {
  const target = await mkdtemp(join(directory, '.staging-'));
  try {
    await capture(target);
    const timestamp = new Date().toISOString().replaceAll(':', '-');
    await rename(target, join(directory, 'snapshot-' + timestamp));
    break;
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    if (attempt === 3) throw error;
    await delay(attempt * 1000);
  }
}
for (const name of await readdir(directory)) {
  if (!/^snapshot-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/.test(name)) continue;
  const path = join(directory, name);
  if (Date.now() - (await stat(path)).mtimeMs > 7 * 86400000) await rm(path, { recursive: true, force: true });
}
console.log('Consistent SQLite snapshots written.');
