import http from 'node:http';
import {checkout} from './client/retry.mjs';
import {charge} from './server/charge.mjs';
import {createState, snapshot} from './server/state.mjs';
import {traceRequest} from './observability/tracing.mjs';
import {observeRequest, metricsSnapshot} from './metrics.mjs';

const state = createState();
const localEffects = {charges: [], confirmations: []};
let effectsUrl = process.env.PAYMENT_EFFECTS_URL;
async function body(request) {
  let value = '';
  for await (const chunk of request) {
    value += chunk;
    if (value.length > 8192) throw new Error('Request body is too large');
  }
  return JSON.parse(value);
}
function send(response, status, value) {
  response.writeHead(status, {'content-type': 'application/json'});
  response.end(JSON.stringify(value));
}
const server = http.createServer(async (request, response) => {
  traceRequest(response);
  observeRequest();
  try {
    if (request.method === 'GET' && request.url === '/health') return send(response, 200, {ready: true});
    if (request.method === 'GET' && request.url === '/state') return send(response, 200, snapshot(state));
    if (request.method === 'GET' && request.url === '/metrics') return send(response, 200, metricsSnapshot());
    // A stand-alone demonstration provider. The trusted validator supplies a
    // separate provider process, and never trusts this application's ledger.
    if (request.method === 'POST' && request.url === '/effects/charge') {
      const input = await body(request);
      const receipt = {...input, chargeId: `charge-${localEffects.charges.length + 1}`};
      localEffects.charges.push(receipt); return send(response, 200, receipt);
    }
    if (request.method === 'POST' && request.url === '/effects/confirmation') {
      localEffects.confirmations.push(await body(request)); return send(response, 200, {sent: true});
    }
    if (request.method === 'POST' && request.url === '/charge') {
      const payment = await charge(state, await body(request), request.headers['idempotency-key'], effectsUrl);
      return send(response, 200, payment);
    }
    if (request.method === 'POST' && request.url === '/checkout') {
      const input = await body(request);
      try { return send(response, 200, await checkout(input)); }
      catch { return send(response, 502, {error: 'The payment response was unavailable'}); }
    }
    send(response, 404, {error: 'Not found'});
  } catch (error) { send(response, 400, {error: error.message}); }
});
server.listen(0, '127.0.0.1', () => {
  effectsUrl ??= `http://127.0.0.1:${server.address().port}/effects`;
  process.stdout.write(JSON.stringify({ready: true, port: server.address().port}) + '\n');
});
