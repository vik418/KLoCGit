import assert from 'node:assert';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  computeFutureRevisionStateDigest,
  computeFutureRevisionRecordDigest,
  computeEffectDigest,
  computeCandidateSpecDigest,
  computeCandidateDigest,
  computeEvidenceDigest,
  computeSystemRevisionStateDigest,
  computeReleaseConstraintsDigest,
  computeDeploymentAttestationDigest,
} from './src/index.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log('================================================================');
console.log('  KLoCGit v1: CROSS-LANGUAGE GOLDEN VECTOR VERIFICATION (P1)   ');
console.log('================================================================');

// 1. Load golden vectors
const vectorsPath = join(__dirname, 'golden_vectors.json');
const vectors: Array<{
  name: string;
  domain_separator: string;
  schema_version: string;
  input: any;
}> = JSON.parse(readFileSync(vectorsPath, 'utf-8'));

// 2. Compute TS digests
const tsResults: Record<string, string> = {};

for (const vec of vectors) {
  let digest = '';
  switch (vec.name) {
    case 'future_revision_state_basic':
      digest = computeFutureRevisionStateDigest(vec.input);
      break;
    case 'future_revision_record_basic':
      digest = computeFutureRevisionRecordDigest(vec.input);
      break;
    case 'effect_set_structural':
      digest = computeEffectDigest(vec.input);
      break;
    case 'candidate_spec_composite':
      digest = computeCandidateSpecDigest(vec.input);
      break;
    case 'candidate_basic':
      digest = computeCandidateDigest(vec.input);
      break;
    case 'evidence_decision_record':
      digest = computeEvidenceDigest(vec.input);
      break;
    case 'system_revision_state_multi_repo':
      digest = computeSystemRevisionStateDigest(vec.input);
      break;
    case 'release_constraints_typed':
      digest = computeReleaseConstraintsDigest(vec.input);
      break;
    case 'deployment_attestation_verified':
      digest = computeDeploymentAttestationDigest(vec.input);
      break;
    default:
      throw new Error(`Unknown golden vector: ${vec.name}`);
  }
  tsResults[vec.name] = digest;
}

// 3. Execute Rust CLI golden runner
console.log('Executing Rust Engine golden vector runner...');
const rustOutputRaw = execSync('cargo run --quiet -p klocgit-engine --bin klocgit-cli -- golden', {
  encoding: 'utf-8',
});

const rustResultsList: Array<{ name: string; digest: string }> = JSON.parse(rustOutputRaw.trim());
const rustResults: Record<string, string> = {};
for (const r of rustResultsList) {
  rustResults[r.name] = r.digest;
}

// 4. Assert 100% byte-identical parity across all golden vectors
console.log('\nCross-Language Digest Verification Matrix:');
console.log('----------------------------------------------------------------');

let passedCount = 0;
for (const vec of vectors) {
  const tsDigest = tsResults[vec.name];
  const rustDigest = rustResults[vec.name];

  assert.ok(tsDigest, `Missing TS digest for ${vec.name}`);
  assert.ok(rustDigest, `Missing Rust digest for ${vec.name}`);
  assert.strictEqual(
    tsDigest,
    rustDigest,
    `MISMATCH for vector ${vec.name}!\n  TS:   ${tsDigest}\n  Rust: ${rustDigest}`
  );

  passedCount++;
  console.log(`[MATCH] ${vec.name}`);
  console.log(`        Digest: ${tsDigest}`);
}

console.log('----------------------------------------------------------------');
console.log(`✓ 100% MATCH: ${passedCount}/${vectors.length} cross-language golden vectors identical between Rust and TypeScript.`);
console.log('================================================================\n');
