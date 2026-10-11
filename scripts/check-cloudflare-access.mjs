/** Verify CI credentials using read-only calls; never print response contents. */
import { randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';

const traceId = randomUUID();
const token = process.env.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!token || !account) {
  console.error(
    JSON.stringify({
      schema_version: 1,
      event: 'cloudflare.access.rejected',
      trace_id: traceId,
      object_id: 'credentials',
      state: 'REJECTED',
      failure_class: 'MISSING_CONFIGURATION',
      missing: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'].filter(
        (name) => !process.env[name],
      ),
    }),
  );
  process.exit(1);
}
const checks = [
  ['workers', '/workers/scripts'],
  ['queues', '/queues?per_page=1'],
];
let failed = false;
for (const [resource, path] of checks) {
  let status = null,
    success = false;
  try {
    const response = await fetch(
      'https://api.cloudflare.com/client/v4/accounts/' + encodeURIComponent(account) + path,
      { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(30000) },
    );
    status = response.status;
    const body = await response.json();
    success = response.ok && body.success === true;
  } catch {
    /* Provider diagnostics can contain private data; report only the class. */
  }
  failed ||= !success;
  console.log(
    JSON.stringify({
      schema_version: 1,
      event: 'cloudflare.access.checked',
      trace_id: traceId,
      object_id: resource,
      state: success ? 'VERIFIED' : 'REJECTED',
      http_status: status,
      failure_class: success
        ? null
        : [401, 403].includes(status)
          ? 'AUTHORIZATION'
          : 'PROVIDER_UNAVAILABLE',
    }),
  );
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `${resource}: ${success ? 'account access verified' : 'account access failed'}\n\n`,
    );
}
process.exitCode = failed ? 1 : 0;
