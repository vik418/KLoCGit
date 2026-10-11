/** Bounded observations and rebuildable summaries. Telemetry grants no authority. */
import {
  V1Error,
  ERROR_TAXONOMY,
  assertSchemaVersion,
  objectId,
  publicError,
} from './conventions.mjs';
import { copyJsonData } from './domain.mjs';
import { digestCanonical } from './encoding.mjs';

export const METRICS = Object.freeze({
  ingestion_latency_ms: 'ms',
  reviewable_latency_ms: 'ms',
  resolvable_latency_ms: 'ms',
  candidate_materialization_ms: 'ms',
  hydrated_bytes_cold: 'bytes',
  hydrated_bytes_warm: 'bytes',
  evidence_queue_latency_ms: 'ms',
  coordinator_wait_ms: 'ms',
  coordinator_transaction_ms: 'ms',
  forward_port_success: 'count',
  forward_port_stale: 'count',
  accepted_change: 'count',
  estimated_cost_microunits: 'currency_microunits',
});

function valid(condition, code = 'INVALID_ARGUMENT') {
  if (!condition) throw new V1Error(code);
}
function contextSnapshot(input) {
  const context = copyJsonData(input);
  assertSchemaVersion(context);
  const fields = ['schema_version', 'tenant_id', 'system_id', 'trace_id', 'subject_id'];
  valid(
    Object.keys(context).length === fields.length &&
      fields.every((key) => Object.hasOwn(context, key)),
  );
  for (const key of fields.slice(1))
    valid(
      typeof context[key] === 'string' &&
        context[key].length > 0 &&
        context[key].length <= 1024 &&
        !/[\u0000-\u001f\u007f]/.test(context[key]),
    );
  return context;
}

export async function verifyMetricObservation(input) {
  const event = copyJsonData(input);
  assertSchemaVersion(event);
  const { id, digest, ...body } = event;
  contextSnapshot(body.context);
  valid(
    Object.keys(body).length === 13 &&
      Object.hasOwn(METRICS, body.metric) &&
      body.unit === METRICS[body.metric],
  );
  valid(
    typeof body.sample_id === 'string' &&
      body.sample_id.length > 0 &&
      body.retention_class === 'REBUILDABLE',
  );
  valid(
    Number.isFinite(body.value) &&
      body.value >= 0 &&
      Number.isSafeInteger(body.occurred_at_ms) &&
      body.occurred_at_ms >= 0,
  );
  valid(
    body.currency === null ||
      (body.metric === 'estimated_cost_microunits' && /^[A-Z]{3}$/.test(body.currency)),
  );
  valid(body.metric !== 'estimated_cost_microunits' || body.currency !== null);
  valid(['OBSERVED', 'ESTIMATED'].includes(body.basis));
  valid(body.basis === (body.metric === 'estimated_cost_microunits' ? 'ESTIMATED' : 'OBSERVED'));
  valid(
    body.failure_class === null ||
      Object.values(ERROR_TAXONOMY).some(
        (definition) => definition.failure_class === body.failure_class,
      ),
  );
  valid(body.from_state === null || body.from_state === 'RUNNING');
  valid(['SUCCEEDED', 'FAILED', 'UNKNOWN'].includes(body.to_state));
  valid(
    (await digestCanonical('object-metric-observation', body)) === digest &&
      objectId('metric-observation', digest) === id,
    'INTEGRITY_MISMATCH',
  );
  return event;
}

export class Telemetry {
  constructor({ sink, now, max_event_bytes, flush_timeout_ms }) {
    valid(
      typeof sink === 'function' &&
        typeof now === 'function' &&
        Number.isSafeInteger(max_event_bytes) &&
        max_event_bytes > 0 &&
        Number.isSafeInteger(flush_timeout_ms) &&
        flush_timeout_ms > 0,
    );
    Object.assign(this, { sink, now, max_event_bytes, flush_timeout_ms, dropped: 0 });
  }

  async record(
    metric,
    value,
    contextInput,
    { currency = null, failure_class = null, from_state = null, to_state = 'SUCCEEDED' } = {},
  ) {
    try {
      const context = contextSnapshot(contextInput);
      valid(Object.hasOwn(METRICS, metric));
      const body = {
        schema_version: 1,
        sample_id: crypto.randomUUID(),
        context,
        metric,
        unit: METRICS[metric],
        value,
        currency,
        basis: metric === 'estimated_cost_microunits' ? 'ESTIMATED' : 'OBSERVED',
        occurred_at_ms: this.now(),
        failure_class,
        from_state,
        to_state,
        retention_class: 'REBUILDABLE',
      };
      const digest = await digestCanonical('object-metric-observation', body);
      const event = await verifyMetricObservation({
        ...body,
        digest,
        id: objectId('metric-observation', digest),
      });
      valid(
        new TextEncoder().encode(JSON.stringify(event)).length <= this.max_event_bytes,
        'INCOMPLETE_ANALYSIS',
      );
      let timer;
      try {
        await Promise.race([
          Promise.resolve().then(() => this.sink(event)),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new V1Error('PROVIDER_UNAVAILABLE')),
              this.flush_timeout_ms,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      return true;
    } catch {
      this.dropped++;
      return false;
    }
  }

  async measure(metric, contextInput, operation) {
    valid(typeof operation === 'function' && METRICS[metric] === 'ms');
    const context = contextSnapshot(contextInput),
      started = this.now();
    let failure;
    try {
      return await operation();
    } catch (error) {
      failure = publicError(error).failure_class;
      throw error;
    } finally {
      await this.record(metric, this.now() - started, context, {
        from_state: 'RUNNING',
        failure_class: failure ?? null,
        to_state: failure === 'AMBIGUOUS' ? 'UNKNOWN' : failure ? 'FAILED' : 'SUCCEEDED',
      });
    }
  }

  async since(metric, started_ms, context) {
    valid(METRICS[metric] === 'ms' && Number.isSafeInteger(started_ms) && started_ms >= 0);
    return this.record(metric, this.now() - started_ms, context);
  }

  async coordinate(store, scope, context, callback) {
    const queued = this.now();
    let entered, finished, failure;
    try {
      return await store.transaction(scope, async (tx) => {
        entered = this.now();
        try {
          return await callback(tx);
        } finally {
          finished = this.now();
        }
      });
    } catch (error) {
      failure = publicError(error).failure_class;
      throw error;
    } finally {
      // The lock is released before any telemetry sink I/O begins.
      if (entered !== undefined) {
        const outcome = {
          from_state: 'RUNNING',
          failure_class: failure ?? null,
          to_state: failure === 'AMBIGUOUS' ? 'UNKNOWN' : failure ? 'FAILED' : 'SUCCEEDED',
        };
        await this.record('coordinator_wait_ms', entered - queued, context, outcome);
        await this.record('coordinator_transaction_ms', finished - entered, context, outcome);
      }
    }
  }
}

/** Explicit rates yield an estimate, never a claim about a provider invoice. */
export function estimateCost(quantity, rate) {
  const value = copyJsonData(rate);
  assertSchemaVersion(value);
  valid(
    Object.keys(value).length === 4 &&
      Number.isSafeInteger(quantity) &&
      quantity >= 0 &&
      Number.isSafeInteger(value.units) &&
      value.units > 0 &&
      Number.isSafeInteger(value.microunits) &&
      value.microunits >= 0 &&
      /^[A-Z]{3}$/.test(value.currency),
  );
  const units = BigInt(value.units),
    cost = (BigInt(quantity) * BigInt(value.microunits) + units - 1n) / units;
  valid(cost <= BigInt(Number.MAX_SAFE_INTEGER));
  return {
    schema_version: 1,
    basis: 'ESTIMATED',
    currency: value.currency,
    microunits: Number(cost),
  };
}

export async function summarizeMetrics(input, { tenant_id, system_id, max_events }) {
  valid(Array.isArray(input) && Number.isSafeInteger(max_events) && max_events > 0);
  if (input.length > max_events) throw new V1Error('INCOMPLETE_ANALYSIS');
  const events = new Map();
  for (const record of copyJsonData(input)) {
    const event = await verifyMetricObservation(record);
    valid(
      event.context.tenant_id === tenant_id && event.context.system_id === system_id,
      'FORBIDDEN',
    );
    events.set(event.id, event);
  }
  const metrics = {},
    costs = {};
  let accepted = 0;
  let from_ms = Infinity,
    to_ms = -Infinity;
  for (const event of events.values()) {
    from_ms = Math.min(from_ms, event.occurred_at_ms);
    to_ms = Math.max(to_ms, event.occurred_at_ms);
    (metrics[event.metric] ??= []).push(event.value);
    if (event.metric === 'accepted_change') accepted += event.value;
    if (event.currency) costs[event.currency] = (costs[event.currency] ?? 0) + event.value;
  }
  const summaries = Object.fromEntries(
    Object.entries(metrics).map(([metric, values]) => {
      values.sort((a, b) => a - b);
      const quantile = (q) => values[Math.max(0, Math.ceil(values.length * q) - 1)];
      return [
        metric,
        {
          schema_version: 1,
          samples: values.length,
          sum: values.reduce((a, b) => a + b, 0),
          p50: quantile(0.5),
          p95: quantile(0.95),
          unit: METRICS[metric],
        },
      ];
    }),
  );
  const success = summaries.forward_port_success?.sum ?? 0,
    stale = summaries.forward_port_stale?.sum ?? 0;
  return {
    schema_version: 1,
    retention_class: 'REBUILDABLE',
    observation_count: events.size,
    period: events.size ? { from_ms, to_ms } : null,
    metrics: summaries,
    forward_port: {
      success,
      stale,
      success_rate: success + stale ? success / (success + stale) : null,
    },
    estimated_cost_per_accepted_change: Object.fromEntries(
      Object.entries(costs).map(([currency, cost]) => [
        currency,
        accepted ? cost / accepted : null,
      ]),
    ),
  };
}
