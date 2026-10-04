import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { git } from '../server/git.mjs';
import { bootstrapWorkspace } from './workspace.mjs';
import { applyApplicationChange } from '../fixtures/application.mjs';
import { contextProvenance } from '../core/context.mjs';
import { DomainError } from '../core/hash.mjs';
import { PRODUCER_METADATA_DIRECTORY } from '../core/metadata.mjs';
const defaultRoot = fileURLToPath(new URL('../.demo-v2/', import.meta.url));
export async function produceWork(engine, root, { ingestionOrder, renameBranches = false } = {}) {
  const state = engine.state,
    task = state.tasks[0];
  if (!task?.authorization)
    throw new DomainError(
      'CONTEXT_REQUIRED',
      'Answer the single retrieved-policy question before starting the task producer.',
      409,
    );
  if (state.proposals.length) return engine.analyzeWork();
  const provenance = await contextProvenance(task);
  const retry = task.snapshot.parameter_values.retry_failed_response;
  const specs = [
    {
      key: 'trace-a',
      producer: 'producer-1',
      title: 'Trace payment requests',
      statement: 'Expose a request identity in HTTP responses.',
      change: 'tracing',
    },
    {
      key: 'trace-b',
      producer: 'producer-2',
      title: 'Add request tracing',
      statement: 'Identify payment HTTP requests.',
      change: 'tracing',
    },
    {
      key: 'metrics',
      producer: 'CI / reliability',
      title: 'Expose request metrics',
      statement: 'Expose an independent HTTP request counter.',
      change: 'metrics',
    },
    {
      key: 'delay-fixed',
      producer: 'producer-1',
      title: 'Fixed retry delay',
      statement: 'Prefer predictable retry timing.',
      change: 'delay-fixed',
      decision_key: 'retry timing',
      choice: 'fixed',
    },
    {
      key: 'delay-exponential',
      producer: 'producer-3',
      title: 'Exponential retry delay',
      statement: 'Reduce request pressure during repeated failure.',
      change: 'delay-exponential',
      decision_key: 'retry timing',
      choice: 'exponential',
    },
    {
      key: 'retry',
      producer: 'producer-2',
      title: retry
        ? 'Retry lost responses with the same identity'
        : 'Expose an uncertain outcome without retry',
      statement: 'Follow the answered policy for a lost payment response.',
      change: retry ? 'retry' : 'no-retry',
      context: true,
    },
    {
      key: 'confirmation',
      producer: 'producer-3',
      title: 'Send confirmation before checking replay',
      statement: 'Notify the customer even when a payment response is unavailable.',
      change: 'confirmation-before-dedupe',
    },
    {
      key: 'docs',
      producer: 'Git client',
      title: 'Document the lost-response contract',
      statement: 'Producer provenance is unavailable.',
      change: 'documentation',
      unknown: true,
    },
  ].map((s, i) => ({
    ...s,
    repo: 'checkout-api',
    key: renameBranches ? `work-${i}-${Math.random().toString(36).slice(2, 8)}` : s.key,
  }));
  const producers = [...new Set(specs.map((s) => s.producer))];
  // Standard independent Git producers, without a precomputed decision graph.
  await Promise.all(
    producers.map(async (producer) => {
      for (const spec of specs.filter((s) => s.producer === producer)) {
        const repo = engine.repo(spec.repo),
          cwd = path.join(root, 'producers', spec.key);
        await mkdir(path.dirname(cwd), { recursive: true });
        // Transport cloning avoids copying transient object-store files while peers push.
        await git(root, ['clone', '--no-local', '--quiet', engine.git.dir(repo), cwd]);
        await git(cwd, ['checkout', '--quiet', '-b', spec.key]);
        if (spec.change === 'no-retry') {
          const filename = path.join(cwd, 'client/retry.mjs');
          const source = await readFile(filename, 'utf8');
          await writeFile(
            filename,
            source.replace(
              'throw lastError;',
              'throw Object.assign(lastError,{uncertainOutcome:true});',
            ),
          );
        } else await applyApplicationChange(cwd, spec.change);
        if (spec.decision_key) {
          await mkdir(path.join(cwd, PRODUCER_METADATA_DIRECTORY), { recursive: true });
          await writeFile(
            path.join(cwd, PRODUCER_METADATA_DIRECTORY, 'proposal.json'),
            JSON.stringify(
              {
                title: spec.title,
                statement: spec.statement,
                decision_key: spec.decision_key,
                choice: spec.choice,
              },
              null,
              2,
            ) + '\n',
          );
        }
        if (spec.context) {
          await mkdir(path.join(cwd, PRODUCER_METADATA_DIRECTORY), { recursive: true });
          await writeFile(
            path.join(cwd, PRODUCER_METADATA_DIRECTORY, 'context.json'),
            JSON.stringify(provenance.artifact, null, 2) + '\n',
          );
        }
        await git(cwd, ['add', '.']);
        const message =
          spec.title + (spec.context ? '\n\n' + provenance.git_trailers.join('\n') : '');
        await git(cwd, ['commit', '--quiet', '-m', message]);
        await git(cwd, ['push', '--quiet', 'origin', spec.key]);
        spec.head = await git(cwd, ['rev-parse', 'HEAD']);
      }
    }),
  );
  const ordered = ingestionOrder ? ingestionOrder.map((i) => specs[i]) : specs;
  for (const spec of ordered) {
    const result = await engine.ingest(
      { repo: spec.repo, ref: `refs/heads/${spec.key}`, after: spec.head },
      {
        title: spec.title,
        statement: spec.statement,
        producer: spec.producer,
        provenance_state: spec.unknown ? 'unknown' : 'declared',
      },
    );
    spec.revision = result.revision_id;
  }
  state.workspace.producers = producers;
  await engine.analyzeWork();
  await engine.audit('producers.completed', 'coordinator', {
    count: producers.length,
    ingested: specs.length,
    decisions: state.decisionComponents.length,
    derived: true,
  });
  await engine.save(state);
  return specs;
}
// Tests use an explicit test actor. Interactive startup stays unanswered and runs no producers.
export async function createDemo(root = defaultRoot, save = async () => {}, options = {}) {
  await rm(root, { recursive: true, force: true });
  const { engine, state, adapter } = await bootstrapWorkspace(root, save);
  if (options.pending) return { engine, state, adapter, specs: [] };
  await engine.resolveTask(
    state.tasks[0].task.id,
    { value: options.retry ?? true },
    options.actor ?? 'acceptance-test-actor',
  );
  const specs = await produceWork(engine, root, options);
  return { engine, state, adapter, specs };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { state } = await createDemo(
    defaultRoot,
    async (s) => writeFile(path.join(defaultRoot, 'state.json'), JSON.stringify(s, null, 2)),
    { pending: true },
  );
  console.log(
    JSON.stringify(
      {
        status: 'needs_clarification',
        task: state.tasks[0].question.statement,
        producersStarted: 0,
        repositories: state.repositories.map((r) => ({ repo: r.id, clone: r.remote })),
      },
      null,
      2,
    ),
  );
}
