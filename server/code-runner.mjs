import { spawn } from 'node:child_process';

export function makeCodeRunner(launcher) {
  if (!launcher) return undefined;
  return async (source, signal) => {
    if (typeof source !== 'string' || !source.trim() || Buffer.byteLength(source) > 32000) {
      throw new Error('代码必须在 32 KB 以内。');
    }
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(20000)]);
    deadline.throwIfAborted();
    const child = spawn('/usr/bin/sudo', ['-n', launcher], { env: {}, signal: deadline });
    const output = [];
    let bytes = 0;
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => {
        const available = 16000 - bytes;
        if (available > 0) output.push(chunk.subarray(0, available));
        bytes += chunk.length;
        if (available > 0 && bytes > 16000) child.kill();
      });
    }
    const finished = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.stdin.once('error', reject);
      child.once('close', (exitCode) => resolve({ exitCode, output: Buffer.concat(output).toString(), truncated: bytes > 16000 }));
    });
    child.stdin.end(source);
    return finished;
  };
}
