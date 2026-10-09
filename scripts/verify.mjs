import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const traceId = randomUUID();
// Test commits belong to disposable fixtures, not the developer's Git identity.
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'klocgit tests',
  GIT_AUTHOR_EMAIL: 'tests@localhost',
  GIT_COMMITTER_NAME: 'klocgit tests',
  GIT_COMMITTER_EMAIL: 'tests@localhost',
};
const steps = [
  ['npm', ['ci']],
  ['npm', ['run', 'check']],
  ['npx', ['--no-install', 'playwright', 'install', 'chromium']],
  ['npm', ['run', 'test:browser']],
];

for (const [command, args] of steps) {
  const result = spawnSync(command, args, { cwd: project, env, stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    console.error(
      JSON.stringify({
        event: 'verification.failed',
        trace_id: traceId,
        object_id: 'T000',
        state: 'failed',
        command,
        failure_class: result.error?.code ?? result.signal ?? 'CHECK_FAILED',
        exit_code: result.status,
      }),
    );
    process.exit(result.status || 1);
  }
}
