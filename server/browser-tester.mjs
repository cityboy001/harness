import { spawn } from 'node:child_process';

const unavailable = { status: 'unavailable', error: 'The isolated browser was unavailable for this attempt.' };

export function makeBrowserTester(launcher) {
  if (!launcher) return undefined;
  let queue = Promise.resolve();

  function run(files, actions, signal, context) {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve(unavailable);
      const child = spawn('/usr/bin/sudo', ['-n', launcher], { env: {}, stdio: ['pipe', 'pipe', 'ignore'] });
      const chunks = [];
      let bytes = 0;
      const abort = () => {
        child.kill();
        resolve(unavailable);
      };
      signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, 34000);
      const finish = (value) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        resolve(value);
      };
      child.on('error', () => finish(unavailable));
      child.stdin.on('error', () => finish(unavailable));
      child.stdout.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 48000) abort();
        else chunks.push(chunk);
      });
      child.on('close', (code) => {
        if (code !== 0) return finish(unavailable);
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          finish(['passed', 'failed', 'unavailable'].includes(result?.status) ? result : unavailable);
        } catch {
          finish(unavailable);
        }
      });
      child.stdin.end(JSON.stringify({ files, actions, ...context }));
    });
  }

  return (files, actions, signal, context) => {
    const job = queue.then(() => run(files, actions, signal, context));
    queue = job.catch(() => {});
    if (signal.aborted) return Promise.resolve(unavailable);
    return new Promise((resolve, reject) => {
      const cancel = () => resolve(unavailable);
      signal.addEventListener('abort', cancel, { once: true });
      job.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
    });
  };
}
