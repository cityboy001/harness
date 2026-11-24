import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { PublicError } from './models.mjs';

const guest = fileURLToPath(new URL('./guest.mjs', import.meta.url));

export class Guest {
  constructor(directory, id, launcher) {
    const env = process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {};
    this.child = launcher
      ? spawn('/usr/bin/sudo', ['-n', launcher, id], { env, stdio: ['pipe', 'pipe', 'ignore'] })
      : spawn(process.execPath, [guest, join(directory, 'data.sqlite')], {
        env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true
      });
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => {
      let result;
      try {
        result = JSON.parse(line);
      } catch {
        this.stop();
        return;
      }
      this.finish(result.ok ? undefined : new PublicError(422, result.error), result.response);
    });
    this.child.on('error', () => this.stop());
    this.child.on('exit', () => this.stop());
    this.child.stdin.on('error', () => this.stop());
  }

  finish(error, value) {
    if (!this.pending) return;
    const { timer, resolve, reject } = this.pending;
    this.pending = undefined;
    clearTimeout(timer);
    if (error) reject(error);
    else resolve(value);
  }

  send(command, timeout = 3000) {
    if (this.dead || this.pending) return Promise.reject(new PublicError(503, '预览运行环境不可用。'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.finish(new PublicError(504, '预览运行环境响应超时。'));
        this.stop();
      }, timeout);
      this.pending = { timer, resolve, reject };
      this.child.stdin.write(JSON.stringify(command) + '\n');
    });
  }

  stop() {
    if (this.dead) return;
    this.dead = true;
    this.finish(new PublicError(503, '预览运行环境已停止。'));
    this.child.stdin.end();
    const child = this.child;
    const force = setTimeout(() => {
      if (child.exitCode === null) child.kill();
    }, 1500);
    force.unref();
  }
}

export function makePreviews(directory, { launcher, max, idleMs, log }) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const running = new Map();
  const locks = new Map();
  const reserved = new Map();
  const disk = (id) => join(directory, id);
  const removeData = (id) => {
    try {
      rmSync(disk(id), { force: true, recursive: true });
    } catch (error) {
      log.warn({ revision: id, code: error.code }, 'Could not clean old preview database');
    }
  };

  function exclusive(projectId, work) {
    const next = (locks.get(projectId) ?? Promise.resolve()).then(work);
    const tail = next.catch(() => {});
    locks.set(projectId, tail);
    tail.then(() => {
      if (locks.get(projectId) === tail) locks.delete(projectId);
    });
    return next;
  }

  function clear(projectId) {
    running.get(projectId)?.guest.stop();
    running.delete(projectId);
  }

  function capacity(project) {
    if (running.get(project.id)?.guest.dead) clear(project.id);
    const busy = [...running, ...reserved].filter(([id, item]) => id !== project.id && !item.guest?.dead);
    if (busy.some(([, item]) => item.owner === project.user_id)) throw new PublicError(409, '此账号已有运行中的预览，请先停止它。');
    if (new Set(busy.map(([id]) => id)).size >= max) throw new PublicError(503, '当前预览已达到并发上限，请稍后启动。');
  }

  async function openGuest(project, id, files, setup, signal) {
    signal?.throwIfAborted();
    const folder = disk(id);
    if (!setup && !existsSync(join(folder, 'data.sqlite'))) {
      throw new PublicError(500, '找不到该版本的预览数据库，请从备份恢复。');
    }
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    if (setup && project.active_revision) {
      copyFileSync(join(disk(project.active_revision), 'data.sqlite'), join(folder, 'data.sqlite'));
    }
    const guest = new Guest(folder, id, launcher);
    const cancel = () => guest.stop();
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      await guest.send({ type: 'load', source: files['server.js'], setup }, 20000);
      return guest;
    } catch (error) {
      guest.stop();
      throw error;
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  }

  function install(project, id, guest) {
    clear(project.id);
    running.set(project.id, { owner: project.user_id, id, guest, touched: Date.now() });
  }

  const timer = setInterval(() => {
    for (const [id, run] of running) {
      if (run.guest.dead || Date.now() - run.touched > idleMs) {
        void exclusive(id, () => {
          if (running.get(id) === run && (run.guest.dead || Date.now() - run.touched > idleMs)) clear(id);
        });
      }
    }
  }, Math.min(10000, idleMs));
  timer.unref();

  return {
    status(projectId) {
      const run = running.get(projectId);
      if (reserved.has(projectId) && !run) return 'starting';
      return run && !run.guest.dead ? 'running' : 'stopped';
    },
    async activate(project, id, files, commit, signal) {
      return exclusive(project.id, async () => {
        let startAutomatically = true;
        try {
          capacity(project);
        } catch {
          startAutomatically = false;
        }
        reserved.set(project.id, { owner: project.user_id });
        let guest;
        try {
          if (reserved.size > max + 1) throw new PublicError(503, '预览环境繁忙，请稍后重试生成。');
          guest = await openGuest(project, id, files, true, signal);
          commit();
          if (startAutomatically) install(project, id, guest);
          else guest.stop();
          if (project.active_revision) removeData(project.active_revision);
        } catch (error) {
          guest?.stop();
          removeData(id);
          throw error;
        } finally {
          reserved.delete(project.id);
        }
      });
    },
    async start(project, reopen, signal) {
      return exclusive(project.id, async () => {
        const { current, revision, initialize } = reopen();
        project = current;
        if (running.get(project.id)?.id === project.active_revision && !running.get(project.id).guest.dead) return;
        capacity(project);
        reserved.set(project.id, { owner: project.user_id });
        let guest;
        try {
          guest = await openGuest(initialize ? { ...project, active_revision: null } : project, revision.id, JSON.parse(revision.files), Boolean(initialize), signal);
          if (initialize) initialize();
          install(project, revision.id, guest);
        } catch (error) {
          guest?.stop();
          if (initialize) removeData(revision.id);
          throw error;
        } finally {
          reserved.delete(project.id);
        }
      });
    },
    stop(projectId) {
      return exclusive(projectId, () => clear(projectId));
    },
    delete(projectId, action) {
      return exclusive(projectId, () => {
        const revisions = action();
        clear(projectId);
        revisions.forEach(({ id }) => removeData(id));
      });
    },
    touch(projectId, revisionId) {
      const run = running.get(projectId);
      if (!run || run.guest.dead || run.id !== revisionId) throw new PublicError(409, '预览已停止或版本已更新。');
      run.touched = Date.now();
      return run;
    },
    request(projectId, revisionId, input, authorize) {
      return exclusive(projectId, () => {
        authorize();
        const run = this.touch(projectId, revisionId);
        return run.guest.send({ type: 'request', input });
      });
    },
    async close() {
      clearInterval(timer);
      await Promise.all(locks.values());
      for (const id of running.keys()) clear(id);
    }
  };
}
