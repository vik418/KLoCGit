/** Optional benchmark provider. Model inference receives data and no host credentials. */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isAbsolute } from 'node:path';
import { V1Error } from '../../core/v1/conventions.mjs';
import { copyJsonData } from '../../core/v1/domain.mjs';

export async function createRanker({
  python = process.env.KLOCGIT_RANKER_PYTHON,
  directory = process.env.KLOCGIT_RANKER_MODEL_DIRECTORY,
  run = execFile,
} = {}) {
  if (
    typeof python !== 'string' ||
    !isAbsolute(python) ||
    typeof directory !== 'string' ||
    !isAbsolute(directory) ||
    typeof run !== 'function'
  )
    throw new V1Error('INVALID_ARGUMENT');
  const manifest = JSON.parse(
    await readFile(new URL('./ranker-model.json', import.meta.url), 'utf8'),
  );
  return Object.freeze({
    metadata: Object.freeze({
      ...manifest,
      basis: 'INFERRED',
      runtime: 'onnxruntime-cpu',
      scope: 'General review-query relevance; source text is truncated to the pinned token budget.',
    }),
    async rank(specs, summary, { signal } = {}) {
      const body = JSON.stringify(
        copyJsonData({
          schema_version: 1,
          candidate_specs: specs,
          evidence_summary: summary,
        }),
      );
      if (Buffer.byteLength(body) > 1048576) throw new V1Error('INCOMPLETE_ANALYSIS');
      return new Promise((resolve, reject) => {
        const child = run(
          python,
          [fileURLToPath(new URL('./model_ranker.py', import.meta.url)), directory],
          {
            signal,
            timeout: 30000,
            maxBuffer: 16384,
            encoding: 'utf8',
            env: {
              PATH: '/usr/bin:/bin',
              TOKENIZERS_PARALLELISM: 'false',
              OMP_NUM_THREADS: '1',
              OPENBLAS_NUM_THREADS: '1',
            },
          },
          (error, stdout) => {
            if (error) return reject(new V1Error('PROVIDER_UNAVAILABLE'));
            try {
              resolve(JSON.parse(stdout));
            } catch {
              reject(new V1Error('PROVIDER_UNAVAILABLE'));
            }
          },
        );
        child.stdin.on('error', () => {});
        child.stdin.end(body);
      });
    },
  });
}
