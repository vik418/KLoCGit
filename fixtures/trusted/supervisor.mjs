// Platform-owned validator. It is mounted separately from the read-only candidate.
import http from 'node:http';
import {spawn} from 'node:child_process';

const CHECK_ID = 'platform:lost-response-exactly-once-v1';
const limitations = [
  'Two finite black-box HTTP scenarios establish only the observed charge and confirmation counts.',
  'The fixture ledger simulates payment and email effects; no real money or email is involved.',
  'Candidate scripts and producer-supplied tests are not used as validation evidence.',
  'The normal case and one lost processed response do not establish correctness for all failures or malicious behavior.'
];
let candidate;
let proxy;
let effectsProvider;
let effectsUrl;
const trustedLedger = {charges: [], confirmations: []};
let candidateOutputBytes = 0;
let candidateError = '';

async function readyCandidate() {
  candidate = spawn(process.execPath, [
    '--permission', '--allow-fs-read=/candidate', '--no-addons',
    '--disable-proto=throw', '--max-old-space-size=64', '--max-semi-space-size=4',
    '/candidate/app.mjs'
  ], {cwd: '/candidate', env: {LANG: 'C.UTF-8', TZ: 'UTC', PAYMENT_EFFECTS_URL: effectsUrl}, stdio: ['ignore', 'pipe', 'pipe']});
  return new Promise((resolve, reject) => {
    let pending = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('Candidate did not become ready within 2 seconds')), 2000);
    function bounded(chunk) {
      candidateOutputBytes += chunk.length;
      if (candidateOutputBytes > 32768) {
        candidate.kill('SIGKILL');
        finish(new Error('Candidate exceeded the 32 KiB output limit'));
        return false;
      }
      return true;
    }
    candidate.stdout.on('data', chunk => {
      if (!bounded(chunk) || settled) return;
      pending += chunk.toString();
      const end = pending.indexOf('\n');
      if (end < 0) return;
      try {
        const message = JSON.parse(pending.slice(0, end));
        if (message.ready !== true || !Number.isInteger(message.port) || message.port < 1 || message.port > 65535) {
          throw new Error('Candidate did not emit a valid ready port');
        }
        finish(null, `http://127.0.0.1:${message.port}`);
      } catch (error) { finish(error); }
    });
    candidate.stderr.on('data', chunk => {
      if (bounded(chunk)) candidateError += chunk.toString();
    });
    candidate.on('error', error => finish(error));
    candidate.on('exit', (code, signal) => finish(new Error(`Candidate exited before readiness (${code ?? signal})`)));
  });
}

async function request(url, {body, method = body === undefined ? 'GET' : 'POST'} = {}) {
  const response = await fetch(url, {
    method, headers: {'content-type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(1500)
  });
  const text = await response.text();
  if (text.length > 32768) throw new Error('Candidate HTTP response exceeded 32 KiB');
  return {status: response.status, headers: Object.fromEntries(response.headers), body: JSON.parse(text)};
}

async function run() {
  // The producer has neither the ledger nor a way to change provider handlers.
  // Provider effects are observed by this trusted process over actual HTTP.
  effectsProvider = http.createServer(async (incoming, outgoing) => {
    try {
      let text = '';
      for await (const chunk of incoming) {text += chunk; if (text.length > 8192) throw new Error('Effect request exceeded 8 KiB');}
      const value = JSON.parse(text);
      if (incoming.method !== 'POST') throw new Error('Only POST is supported');
      if (incoming.url === '/charge') {
        const receipt = {...value, chargeId: `charge-${trustedLedger.charges.length + 1}`};
        trustedLedger.charges.push(receipt);
        outgoing.writeHead(200, {'content-type': 'application/json'}); outgoing.end(JSON.stringify(receipt)); return;
      }
      if (incoming.url === '/confirmation') {
        trustedLedger.confirmations.push(value);
        outgoing.writeHead(200, {'content-type': 'application/json'}); outgoing.end(JSON.stringify({sent: true})); return;
      }
      outgoing.writeHead(404); outgoing.end();
    } catch {outgoing.writeHead(400); outgoing.end();}
  });
  await new Promise((resolve, reject) => {effectsProvider.once('error', reject); effectsProvider.listen(0, '127.0.0.1', resolve);});
  effectsUrl = `http://127.0.0.1:${effectsProvider.address().port}`;
  const baseUrl = await readyCandidate();
  const health = await request(`${baseUrl}/health`);
  if (health.status !== 200) throw new Error('Candidate health endpoint did not return 200');
  const normal = await request(`${baseUrl}/checkout`, {body: {
    baseUrl, orderId: 'order-normal', amountCents: 1000, idempotencyKey: 'key-normal'
  }});

  // This transport belongs to the platform. It forwards real HTTP requests and
  // drops the first response only AFTER the payment server has processed it.
  const transport = {attempts: 0, processedResponses: 0, suppressedResponses: 0, idempotencyKeys: []};
  proxy = http.createServer(async (incoming, outgoing) => {
    try {
      let body = '';
      for await (const chunk of incoming) {
        body += chunk;
        if (body.length > 8192) throw new Error('Payment request exceeded 8 KiB');
      }
      if (incoming.method !== 'POST' || incoming.url !== '/charge') {
        outgoing.writeHead(404); outgoing.end(); return;
      }
      transport.attempts++;
      transport.idempotencyKeys.push(incoming.headers['idempotency-key'] ?? null);
      const upstream = await fetch(`${baseUrl}/charge`, {
        method: 'POST', headers: {'content-type': 'application/json', 'idempotency-key': incoming.headers['idempotency-key'] ?? ''},
        body, signal: AbortSignal.timeout(1000)
      });
      const response = await upstream.text();
      if (response.length > 32768) throw new Error('Upstream response exceeded 32 KiB');
      transport.processedResponses++;
      if (transport.suppressedResponses === 0) {
        transport.suppressedResponses++;
        outgoing.destroy();
        return;
      }
      outgoing.writeHead(upstream.status, {'content-type': 'application/json'});
      outgoing.end(response);
    } catch { outgoing.destroy(); }
  });
  await new Promise((resolve, reject) => {proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve);});
  const lost = await request(`${baseUrl}/checkout`, {body: {
    baseUrl: `http://127.0.0.1:${proxy.address().port}`,
    orderId: 'order-lost-response', amountCents: 1000, idempotencyKey: 'key-lost-response'
  }});
  const count = (items, order) => items.filter(item => item.orderId === order).length;
  const normalEffects = {charges: count(trustedLedger.charges, 'order-normal'), confirmations: count(trustedLedger.confirmations, 'order-normal')};
  const lostEffects = {charges: count(trustedLedger.charges, 'order-lost-response'), confirmations: count(trustedLedger.confirmations, 'order-lost-response')};
  const checks = [
    {name: 'Normal checkout has exactly one charge and one confirmation', passed: normal.status === 200 && normalEffects.charges === 1 && normalEffects.confirmations === 1,
      detail: `HTTP ${normal.status}; charges=${normalEffects.charges}; confirmations=${normalEffects.confirmations}.`},
    {name: 'Platform transport loses one processed payment response', passed: transport.suppressedResponses === 1 && transport.processedResponses >= 1,
      detail: `${transport.processedResponses} processed HTTP response(s); one was suppressed after payment processing.`},
    {name: 'Lost-response checkout has exactly one charge and one confirmation', passed: lostEffects.charges === 1 && lostEffects.confirmations === 1,
      detail: `HTTP ${lost.status}; attempts=${transport.attempts}; charges=${lostEffects.charges}; confirmations=${lostEffects.confirmations}.`},
    {name: 'Trusted provider received the requested payment amount', passed: trustedLedger.charges.length === 2 && trustedLedger.charges.every(item => item.amountCents === 1000),
      detail: `${trustedLedger.charges.length} provider-side charge(s); all observed amounts must equal 1,000 cents.`},
    {name: 'Retries retain the order idempotency key', passed: transport.attempts >= 1 && transport.idempotencyKeys.every(key => key === 'key-lost-response'),
      detail: `${transport.attempts} actual HTTP attempt(s) retained one order key.`}
  ];
  return {passed: checks.every(check => check.passed), checks,
    suite: {id: CHECK_ID, version: 1, footprint: ['client/retry.mjs', 'server/charge.mjs'], ownership: 'platform'},
    observations: {source: 'platform-owned external HTTP effect provider', normal: normalEffects, lostResponse: {...lostEffects, status: lost.status, ...transport}},
    scope: ['client/retry.mjs', 'server/charge.mjs'], limitations};
}

let result;
try { result = await run(); }
catch (error) {
  result = {passed: false, status: 'execution-failed', checks: [{name: 'Sandboxed HTTP validation completes', passed: false,
    detail: String(error.message).slice(0, 500)}], suite: {id: CHECK_ID, version: 1, footprint: ['client/retry.mjs', 'server/charge.mjs'], ownership: 'platform'},
    scope: ['client/retry.mjs', 'server/charge.mjs'], limitations};
}
finally {
  if (proxy) {proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve));}
  if (effectsProvider) {effectsProvider.closeAllConnections(); await new Promise(resolve => effectsProvider.close(resolve));}
  if (candidate && candidate.exitCode === null && candidate.signalCode === null) {
    const exited = new Promise(resolve => candidate.once('exit', resolve));
    candidate.kill('SIGKILL'); await exited;
  }
}
// Candidate stdout/stderr is never forwarded into this trusted result channel.
process.stdout.write(JSON.stringify(result) + '\n');
