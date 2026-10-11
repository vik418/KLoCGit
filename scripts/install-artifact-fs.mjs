/** Build the pinned native adapter tool outside the source checkout. */
import { readFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { isAbsolute, join } from 'node:path';

const [directory, goBinary] = process.argv.slice(2);
if (!directory || !goBinary || !isAbsolute(directory) || !isAbsolute(goBinary)) {
  throw new Error(
    'Usage: node scripts/install-artifact-fs.mjs <absolute-directory> <absolute-go-binary>',
  );
}
const toolchain = JSON.parse(
  await readFile(
    new URL('../adapters/cloudflare/artifact-fs-toolchain.json', import.meta.url),
    'utf8',
  ),
);
await mkdir(join(directory, 'bin'), { recursive: true, mode: 0o700 });
const status = await new Promise((resolve, reject) => {
  const child = spawn(goBinary, ['install', toolchain.module + '@' + toolchain.version], {
    env: {
      ...process.env,
      GOTOOLCHAIN: 'local',
      GOBIN: join(directory, 'bin'),
      GOCACHE: join(directory, 'go-cache'),
      GOMODCACHE: join(directory, 'go-modules'),
    },
    stdio: 'inherit',
  });
  child.on('error', reject);
  child.on('exit', resolve);
});
if (status !== 0) process.exit(status || 1);
