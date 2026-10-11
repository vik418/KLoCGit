/** Test-only runner: compile JSON fixtures with the fixed trusted helper in isolation mode. */
import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(
  new URL('../../adapters/analysis/python_analyzer.py', import.meta.url),
);
const python = (process.env.PATH ?? '')
  .split(path.delimiter)
  .filter(Boolean)
  .map((directory) => path.resolve(directory, 'python3.12'))
  .find((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });

export function pythonAnalysisRunner(request) {
  if (!python) return Promise.reject(new Error('CPython 3.12 fixture runtime is unavailable.'));
  return new Promise((resolve, reject) => {
    // PATH is used only to locate the executable. The child receives no ambient
    // environment, credentials, producer import path, or executable source file.
    const child = spawn(python, ['-I', '-B', helper], {
      env: {},
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const chunks = [];
    let bytes = 0;
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) child.kill('SIGKILL');
      else chunks.push(chunk);
    });
    child.on('error', () => {
      clearTimeout(timer);
      reject(new Error('Trusted Python fixture runner failed.'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || bytes > 1024 * 1024) {
        reject(new Error('Trusted Python fixture runner failed.'));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Trusted Python fixture response is invalid.'));
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(request));
  });
}
