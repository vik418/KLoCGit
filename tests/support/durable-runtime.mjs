import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { fileURLToPath } from 'node:url';

/** Bundle the adapter itself, rather than replacing storage with an in-memory fake. */
export async function durableRuntime(persist) {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('./coordination-worker.mjs', import.meta.url))],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'esm',
  });
  return new Miniflare({
    resourcePersistencePath: typeof persist === 'string' ? persist : undefined,
    workers: [
      {
        config: {
          name: 'coordination-test',
          compatibilityDate: '2026-10-02',
          manifest: {
            mainModule: 'main.mjs',
            modulesRoot: process.cwd(),
            modules: { 'main.mjs': { type: 'esm', contents: bundle.outputFiles[0].text } },
          },
          env: {
            COORDINATOR: {
              type: 'durable-object',
              worker: 'coordination-test',
              exportName: 'TestCoordinator',
            },
          },
          exports: { TestCoordinator: { type: 'durable-object', storage: 'sqlite' } },
        },
      },
    ],
  });
}

export async function durableRequest(runtime, input) {
  const response = await runtime.dispatchFetch('https://coordination.test/', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return { status: response.status, body: await response.json() };
}
