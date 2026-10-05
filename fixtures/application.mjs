import { cp, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const applicationFixturePath = fileURLToPath(new URL('./checkout-api/', import.meta.url));
export const policyFixturePath = fileURLToPath(new URL('./payment-policy/', import.meta.url));

export async function copyApplicationFixture(destination) {
  await cp(applicationFixturePath, destination, { recursive: true });
  // Ordinary documentation producers need a README in the generated Git repository.
  await writeFile(
    path.join(destination, 'README.md'),
    '# Checkout application\n\nRun `node app.mjs` to start the payment HTTP application.\n',
  );
}
export async function copyPolicyFixture(destination) {
  await cp(policyFixturePath, destination, { recursive: true });
}

function replaceOnce(source, before, after) {
  if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before)) {
    throw new Error(`Fixture change requires one matching source fragment: ${before}`);
  }
  return source.replace(before, after);
}

/** Mutations make ordinary producer commits; no grouping metadata is supplied. */
export async function applyApplicationChange(destination, change) {
  const retryPath = path.join(destination, 'client/retry.mjs');
  const chargePath = path.join(destination, 'server/charge.mjs');
  if (change === 'retry' || change === 'retry-immediate' || change === 'retry-backoff') {
    let source = await readFile(retryPath, 'utf8');
    source = replaceOnce(
      source,
      'export const MAX_ATTEMPTS = 1;',
      'export const MAX_ATTEMPTS = 2;',
    );
    await writeFile(retryPath, source);
    return ['client/retry.mjs'];
  }
  if (change === 'delay-fixed' || change === 'delay-exponential') {
    const filename = path.join(destination, 'config/retry-delay.mjs');
    const source = await readFile(filename, 'utf8');
    await writeFile(
      filename,
      replaceOnce(
        source,
        "export const RETRY_STRATEGY = 'none';",
        `export const RETRY_STRATEGY = '${change === 'delay-fixed' ? 'fixed' : 'exponential'}';`,
      ),
    );
    return ['config/retry-delay.mjs'];
  }
  if (change === 'confirmation-before-dedupe') {
    const source = await readFile(chargePath, 'utf8');
    const start = source.indexOf('  const confirmation = ');
    const end = source.indexOf('  state.receipts.set(', start);
    if (start < 0 || end < 0) throw new Error('Baseline confirmation code was not found');
    // Move the existing effect before replay detection, retaining the rest of the function.
    const sideEffect = replaceOnce(
      source.slice(start, end),
      'receipt: receipt.chargeId',
      "receipt: 'pending'",
    );
    const after = replaceOnce(
      source.slice(0, start) + source.slice(end),
      '  const previous = state.receipts.get(idempotencyKey);',
      sideEffect + '  const previous = state.receipts.get(idempotencyKey);',
    );
    await writeFile(chargePath, after);
    return ['server/charge.mjs'];
  }
  if (change === 'tracing') {
    const filename = path.join(destination, 'observability/tracing.mjs');
    const source = await readFile(filename, 'utf8');
    await writeFile(
      filename,
      replaceOnce(
        source,
        'export const TRACE_REQUESTS = false;',
        'export const TRACE_REQUESTS = true;',
      ),
    );
    return ['observability/tracing.mjs'];
  }
  if (change === 'metrics') {
    const filename = path.join(destination, 'metrics.mjs');
    await writeFile(
      filename,
      replaceOnce(
        await readFile(filename, 'utf8'),
        'export const METRICS_ENABLED = false;',
        'export const METRICS_ENABLED = true;',
      ),
    );
    return ['metrics.mjs'];
  }
  if (change === 'documentation') {
    const filename = path.join(destination, 'README.md');
    await writeFile(
      filename,
      (await readFile(filename, 'utf8')) +
        '\nA processed payment can outlive its HTTP response. Confirmation and charge counts are bounded by the payment policy.\n',
    );
    return ['README.md'];
  }
  throw new Error(`Unknown application change: ${change}`);
}
