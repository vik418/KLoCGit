import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

// Cloudflare start() supplies private manifest + repository-specific credentials.
// The manifest never contains token values and is not part of the built image.
if (!process.env.GIT_EXECUTOR_MANIFEST_JSON || !process.env.GIT_BRIDGE_TOKEN)
  throw new Error('EXECUTOR_UNCONFIGURED');
const manifest = JSON.parse(process.env.GIT_EXECUTOR_MANIFEST_JSON);
manifest.cacheDirectory = '/var/lib/klocgit/git';
await mkdir('/var/lib/klocgit', { recursive: true, mode: 0o700 });
const manifestPath = '/var/lib/klocgit/manifest.json';
await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
const child = spawn(process.execPath, ['server/bridge.mjs'], {
  stdio: 'inherit',
  env: { ...process.env, GIT_EXECUTOR_MANIFEST: manifestPath },
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
child.on('error', () => {
  console.error('Trusted executor failed to start.');
  process.exit(1);
});
