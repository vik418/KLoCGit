import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { canonicalEncode, hashProjection, payloadDigest } from '../src/index.ts';

type Vector = {
  name: string;
  domain: string;
  projection?: unknown;
  payload_hex?: string;
  cbor_hex?: string;
  expected_digest: string;
};

test('Rust and TypeScript match the independent canonical vectors', async () => {
  const vectors: Vector[] = JSON.parse(readFileSync(new URL('../../../tests/fixtures/canonical.golden.json', import.meta.url), 'utf8'));
  const requests = vectors.map((vector) => vector.payload_hex === undefined
    ? { kind: 'projection', domain: vector.domain, projection: vector.projection }
    : { kind: 'payload', payload_hex: vector.payload_hex });
  const native = spawnSync('cargo', ['run', '--quiet', '-p', 'klocgit-engine', '--bin', 'klocgit-canonical'], {
    input: JSON.stringify(requests),
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.ifError(native.error);
  assert.equal(native.status, 0, native.stderr);
  const responses: { cbor_hex?: string; projection_digest: string }[] = JSON.parse(native.stdout);
  assert.equal(responses.length, vectors.length);
  for (const [index, vector] of vectors.entries()) {
    const response = responses[index];
    if (vector.payload_hex !== undefined) {
      const actual = await payloadDigest(Uint8Array.from(Buffer.from(vector.payload_hex, 'hex')));
      assert.equal(actual, vector.expected_digest, vector.name);
      assert.equal(response.projection_digest, actual, vector.name);
    } else {
      const bytes = Buffer.from(canonicalEncode(vector.projection)).toString('hex');
      const actual = await hashProjection(vector.domain, vector.projection);
      assert.equal(bytes, vector.cbor_hex, vector.name);
      assert.equal(response.cbor_hex, bytes, vector.name);
      assert.equal(actual, vector.expected_digest, vector.name);
      assert.equal(response.projection_digest, actual, vector.name);
    }
  }
});
