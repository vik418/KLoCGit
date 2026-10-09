import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const project = fileURLToPath(new URL('../', import.meta.url));
const eslint = new ESLint({ cwd: project });

test('the domain package has no Cloudflare dependency or forbidden import', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../core/package.json', import.meta.url), 'utf8'),
  );
  for (const dependency of Object.keys({
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.peerDependencies,
    ...manifest.optionalDependencies,
  })) {
    assert.ok(!dependency.startsWith('@cloudflare/'), dependency);
    assert.ok(!['wrangler', 'miniflare'].includes(dependency), dependency);
  }
  const results = await eslint.lintFiles(['core/**/*.mjs']);
  const violations = results.flatMap((result) =>
    result.messages
      .filter((message) => message.ruleId === 'no-restricted-imports')
      .map((message) => ({ file: result.filePath, message: message.message })),
  );
  assert.deepEqual(violations, []);
});

test('domain imports and re-exports reject providers and runtime modules', async () => {
  for (const dependency of [
    'cloudflare:workers',
    '@cloudflare/workers-types',
    '@cloudflare/containers',
    'wrangler',
    'miniflare',
    '../server/git.mjs',
    '../worker/artifacts.mjs',
    '../adapters/local/config.mjs',
    '../api/handler.mjs',
    '../src/lib/api.js',
    '../fixtures/application.mjs',
  ]) {
    for (const source of [
      `import value from '${dependency}'; export default value;`,
      `export { value } from '${dependency}';`,
    ]) {
      const results = await eslint.lintText(source, { filePath: 'core/boundary-fixture.mjs' });
      assert.ok(
        results[0].messages.some((message) => message.ruleId === 'no-restricted-imports'),
        dependency,
      );
    }
  }
});

test('the boundary permits domain modules and provider-neutral utilities', async () => {
  const results = await eslint.lintText(
    "import { createHash } from 'node:crypto'; import { hash } from './hash.mjs'; export { createHash, hash };",
    { filePath: 'core/boundary-fixture.mjs' },
  );
  assert.ok(results[0].messages.every((message) => message.ruleId !== 'no-restricted-imports'));
});
