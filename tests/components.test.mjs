import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveDecisionComponents, maximalConsistentSubsets } from '../core/components.mjs';

function fixture(names = ['alpha', 'beta', 'gamma', 'delta', 'unknown']) {
  const revisions = names.map((name) => ({
    id: `revision-${name}`,
    proposal_id: `proposal-${name}`,
    repo: 'service',
    head_commit: `head-${name}`,
    tree_hash: `tree-${name}`,
    provenance_state: name === 'unknown' ? 'unknown' : 'declared',
  }));
  return {
    revisions,
    proposals: names.map((name) => ({
      id: `proposal-${name}`,
      repo: 'service',
      ref: `refs/heads/${name}`,
      title: `${name} outcome`,
      statement: `Intent ${name}`,
    })),
    refVersions: Object.fromEntries(
      names.map((name) => [`service:refs/heads/${name}`, `head-${name}`]),
    ),
    repositories: [{ id: 'service', head: 'baseline' }],
    validation_config_hash: 'trusted-config',
    constraints: [],
    relationships: [],
    evidence: [],
    compositions: [],
    decisionComponents: [],
  };
}
function relation(left, right, type = 'alternative', extra = {}) {
  return {
    id: `edge-${left}-${right}-${type}`,
    from_revision: `revision-${left}`,
    to_revision: `revision-${right}`,
    type,
    basis: 'declared',
    evidence_refs: [],
    ...extra,
  };
}
function pairEvidence(state, left, right, extra = {}) {
  const ids = [`revision-${left}`, `revision-${right}`];
  state.compositions.push({
    id: `composition-${left}-${right}`,
    proposal_revision_ids: ids,
    resulting_tree: `composed-${left}-${right}`,
  });
  const evidence = {
    id: `evidence-${left}-${right}`,
    subject_ref: `composition-${left}-${right}`,
    tree_hash: `composed-${left}-${right}`,
    config_hash: 'trusted-config',
    source: 'platform-owned checks',
    type: 'trusted-validation',
    result: { passed: false },
    validity_heads: { service: 'baseline' },
    constraint_versions: [],
    ...extra,
  };
  state.evidence.push(evidence);
  state.relationships.push(
    relation(left, right, 'conflicts_with', { basis: 'observed', evidence_refs: [evidence.id] }),
  );
  return evidence;
}
const selections = (component) =>
  component.alternatives
    .map((alternative) => alternative.revision_ids)
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

test('arbitrary shuffled Git work yields the same two connected decisions and excludes unknown overlap', async () => {
  const state = fixture();
  state.relationships.push(
    relation('alpha', 'beta'),
    relation('gamma', 'delta', 'conflicts_with'),
    relation('beta', 'unknown', 'unknown'),
  );
  const first = await deriveDecisionComponents(state);
  assert.equal(first.components.length, 2);
  assert.deepEqual(first.ungrouped_revision_ids, ['revision-unknown']);
  const shuffled = structuredClone(state);
  shuffled.revisions.reverse();
  shuffled.proposals.reverse();
  shuffled.relationships.reverse();
  shuffled.repositories.reverse();
  assert.deepEqual(await deriveDecisionComponents(shuffled), first);
  assert.ok(
    first.components.every((component) => component.explanation.includes('Unknown overlap')),
  );
});

test('compatibility, equivalence, dependencies and unknown edges never connect unrelated decisions', async () => {
  const state = fixture();
  state.relationships.push(relation('alpha', 'beta'));
  for (const type of ['compatible_candidate', 'implementation_equivalent', 'depends_on', 'unknown'])
    state.relationships.push(relation('beta', 'unknown', type));
  const result = await deriveDecisionComponents(state);
  assert.equal(result.components.length, 1);
  assert.deepEqual(result.components[0].revision_ids, ['revision-alpha', 'revision-beta']);
  assert.deepEqual(result.ungrouped_revision_ids, [
    'revision-delta',
    'revision-gamma',
    'revision-unknown',
  ]);
});

test('maximal consistent candidates derive from a connected path without predefined group or option names', async () => {
  const state = fixture(['alpha', 'beta', 'gamma']);
  state.relationships.push(relation('alpha', 'beta'), relation('beta', 'gamma'));
  const {
    components: [component],
  } = await deriveDecisionComponents(state);
  assert.deepEqual(selections(component), [
    ['revision-alpha', 'revision-gamma'],
    ['revision-beta'],
  ]);
  assert.ok(component.alternatives.every((alternative) => alternative.validation === 'required'));
  assert.ok(component.alternatives.every((alternative) => alternative.evidence_ids.length === 0));
  assert.ok(component.alternatives.every((alternative) => alternative.compositions.length === 1));
});

test('same-tree implementation histories remain separate while candidate search deduplicates implementation', async () => {
  const state = fixture(['alpha', 'alias', 'beta']);
  state.revisions.find((revision) => revision.id === 'revision-alias').tree_hash = 'tree-alpha';
  state.relationships.push(relation('alpha', 'beta'));
  const {
    components: [component],
    equivalence_groups,
  } = await deriveDecisionComponents(state, { maxImplementations: 2 });
  assert.equal(component.planning.status, 'complete');
  assert.deepEqual(component.revision_ids, ['revision-alias', 'revision-alpha', 'revision-beta']);
  assert.deepEqual(selections(component), [
    ['revision-alias', 'revision-alpha'],
    ['revision-beta'],
  ]);
  assert.deepEqual(equivalence_groups, [['revision-alias', 'revision-alpha']]);
  assert.notEqual(state.revisions[0].proposal_id, state.revisions[1].proposal_id);
});

test('equivalence alone needs no architectural component and never collapses intent history', async () => {
  const state = fixture(['alpha', 'alias']);
  state.revisions[1].tree_hash = state.revisions[0].tree_hash;
  state.relationships.push(
    relation('alpha', 'alias', 'implementation_equivalent', { basis: 'observed' }),
  );
  const result = await deriveDecisionComponents(state);
  assert.equal(result.components.length, 0);
  assert.deepEqual(result.ungrouped_revision_ids, ['revision-alias', 'revision-alpha']);
  assert.deepEqual(result.equivalence_groups, [['revision-alias', 'revision-alpha']]);
});

test('exact trusted composed-tree failure explains an observed interaction; confidence is irrelevant', async () => {
  const state = fixture(['alpha', 'beta']);
  pairEvidence(state, 'alpha', 'beta');
  state.relationships[0].confidence = 0;
  const {
    components: [component],
  } = await deriveDecisionComponents(state);
  assert.equal(component.edges[0].classification, 'observed-interaction');
  assert.match(component.edges[0].explanation, /exact composed pair/);
  assert.match(component.edges[0].explanation, /does not establish global correctness/);
});

test('stale interaction evidence keeps the component in human review and marks its basis stale', async () => {
  const state = fixture(['alpha', 'beta']);
  pairEvidence(state, 'alpha', 'beta');
  const before = await deriveDecisionComponents(state);
  state.repositories[0].head = 'external-push';
  const {
    components: [component],
  } = await deriveDecisionComponents(state);
  assert.equal(component.id, before.components[0].id);
  assert.equal(component.status, 'open');
  assert.equal(component.basis_stale, true);
  assert.equal(component.edges[0].classification, 'stale-interaction');
  assert.match(component.edges[0].explanation, /fresh composed evidence/);
});

test('missing, forged, stale config and wrong-subject evidence cannot become an observed current interaction', async () => {
  for (const mutation of [
    (state) => {
      state.evidence = [];
    },
    (state) => {
      state.evidence[0].source = 'producer-supplied tests';
    },
    (state) => {
      state.evidence[0].tree_hash = 'different-tree';
    },
    (state) => {
      state.compositions[0].proposal_revision_ids.push('unattributed-third-change');
    },
  ]) {
    const state = fixture(['alpha', 'beta']);
    pairEvidence(state, 'alpha', 'beta');
    mutation(state);
    const {
      components: [component],
    } = await deriveDecisionComponents(state);
    assert.equal(component.status, 'open');
    assert.equal(component.edges[0].classification, 'unverified-conflict');
  }
  const state = fixture(['alpha', 'beta']);
  pairEvidence(state, 'alpha', 'beta');
  const {
    components: [component],
  } = await deriveDecisionComponents(state, {
    evidenceValidity: () => ({ status: 'stale', reasons: ['validation configuration changed'] }),
  });
  assert.equal(component.edges[0].classification, 'stale-interaction');
  delete state.validation_config_hash;
  const withoutConfig = await deriveDecisionComponents(state);
  assert.equal(withoutConfig.components[0].edges[0].classification, 'unverified-conflict');
  assert.equal(withoutConfig.components[0].edges[0].evidence[0].status, 'unknown');
});

test('direct interaction evidence binds exact heads and trees across repositories', async () => {
  const state = fixture(['alpha', 'beta']);
  state.revisions[1].repo = 'policy';
  state.proposals[1].repo = 'policy';
  delete state.refVersions['service:refs/heads/beta'];
  state.refVersions['policy:refs/heads/beta'] = 'head-beta';
  state.repositories.push({ id: 'policy', head: 'policy-baseline' });
  const evidence = {
    id: 'cross-evidence',
    subject_revision_ids: state.revisions.map((revision) => revision.id),
    subject_versions: state.revisions.map((revision) => ({
      revision_id: revision.id,
      head_commit: revision.head_commit,
      tree_hash: revision.tree_hash,
    })),
    source: 'platform-owned interaction checks',
    config_hash: 'trusted-config',
    result: { passed: false },
    validity_heads: { service: 'baseline', policy: 'policy-baseline' },
    constraint_versions: [],
  };
  state.evidence.push(evidence);
  state.relationships.push(
    relation('alpha', 'beta', 'conflicts_with', {
      basis: 'observed',
      evidence_refs: [evidence.id],
    }),
  );
  let result = await deriveDecisionComponents(state);
  assert.equal(result.components[0].edges[0].classification, 'observed-interaction');
  assert.deepEqual(result.components[0].scope, ['policy', 'service']);
  evidence.subject_versions[1].head_commit = 'another-head';
  result = await deriveDecisionComponents(state);
  assert.equal(result.components[0].edges[0].classification, 'unverified-conflict');
});

test('same-repository interaction proof cannot claim a different or missing resulting composition', async () => {
  const state = fixture(['alpha', 'beta']);
  const proof = pairEvidence(state, 'alpha', 'beta');
  proof.subject_ref = ['revision-alpha', 'revision-beta'];
  proof.subject_versions = state.revisions.map((revision) => ({
    revision_id: revision.id,
    head_commit: revision.head_commit,
    tree_hash: revision.tree_hash,
  }));
  proof.type = 'composed-interaction';
  proof.composition_ref = 'composition-alpha-beta';
  assert.equal(
    (await deriveDecisionComponents(state)).components[0].edges[0].classification,
    'observed-interaction',
  );
  proof.composition_ref = 'nonexistent-composition';
  assert.equal(
    (await deriveDecisionComponents(state)).components[0].edges[0].classification,
    'unverified-conflict',
  );
  proof.composition_ref = 'composition-alpha-beta';
  proof.tree_hash = 'unreviewed-tree';
  assert.equal(
    (await deriveDecisionComponents(state)).components[0].edges[0].classification,
    'unverified-conflict',
  );
  delete proof.composition_ref;
  assert.equal(
    (await deriveDecisionComponents(state)).components[0].edges[0].classification,
    'unverified-conflict',
  );
});

test('failed Git composition is described as a merge conflict without inventing a semantic interaction', async () => {
  const state = fixture(['alpha', 'beta']);
  const proof = {
    id: 'git-failure',
    subject_revision_ids: state.revisions.map((revision) => revision.id),
    subject_versions: state.revisions.map((revision) => ({
      revision_id: revision.id,
      head_commit: revision.head_commit,
      tree_hash: revision.tree_hash,
    })),
    composition_ref: null,
    tree_hash: null,
    type: 'textual-composition-conflict',
    source: 'platform-owned interaction checks',
    config_hash: 'trusted-config',
    result: { passed: false },
    validity_heads: { service: 'baseline' },
    constraint_versions: [],
  };
  state.evidence.push(proof);
  state.relationships.push(
    relation('alpha', 'beta', 'conflicts_with', { basis: 'observed', evidence_refs: [proof.id] }),
  );
  const component = (await deriveDecisionComponents(state)).components[0];
  assert.equal(component.kind, 'Merge conflict');
  assert.equal(component.edges[0].classification, 'textual-conflict');
  assert.match(component.edges[0].explanation, /textual merge conflict/);
  state.repositories[0].head = 'new-base';
  const stale = (await deriveDecisionComponents(state)).components[0];
  assert.equal(stale.kind, 'Merge conflict');
  assert.equal(stale.edges[0].classification, 'stale-textual-conflict');
  assert.equal(stale.basis_stale, true);
});

test('inactive and explicitly resolved relationships do not create new decisions', async () => {
  const state = fixture(['alpha', 'beta', 'gamma']);
  state.relationships.push(
    relation('alpha', 'beta'),
    relation('beta', 'gamma', 'conflicts_with', { status: 'resolved' }),
  );
  state.refVersions['service:refs/heads/alpha'] = 'force-pushed-head';
  const result = await deriveDecisionComponents(state);
  assert.deepEqual(result.components, []);
  assert.deepEqual(result.ungrouped_revision_ids, ['revision-beta', 'revision-gamma']);
  assert.equal(result.diagnostics[0].reason, 'inactive revision endpoint');
});

test('new blocking edges join components and generate a changed review basis', async () => {
  const state = fixture(['alpha', 'beta', 'gamma', 'delta']);
  state.relationships.push(relation('alpha', 'beta'), relation('gamma', 'delta'));
  const before = await deriveDecisionComponents(state);
  state.relationships.push(relation('beta', 'gamma', 'conflicts_with'));
  const after = await deriveDecisionComponents(state);
  assert.equal(before.components.length, 2);
  assert.equal(after.components.length, 1);
  assert.ok(before.components.every((component) => component.id !== after.components[0].id));
  assert.equal(after.components[0].edges.length, 3);
});

test('applied and deferred decisions survive canonical movement, but changed immutable members reopen review', async () => {
  for (const status of ['resolved', 'deferred']) {
    const state = fixture(['alpha', 'beta']);
    state.relationships.push(relation('alpha', 'beta'));
    const {
      components: [component],
    } = await deriveDecisionComponents(state);
    component.status = status;
    component.selected = component.alternatives[0].id;
    component.resolution_id = 'historical-decision';
    state.decisionComponents.push(component);
    state.repositories[0].head = 'after-canonical-advance';
    let result = await deriveDecisionComponents(state);
    assert.equal(result.components[0].id, component.id);
    assert.equal(result.components[0].status, status);
    assert.equal(result.components[0].resolution_id, 'historical-decision');
    const updated = state.revisions[0];
    const oldId = updated.id;
    updated.id += '-v2';
    updated.head_commit += '-v2';
    state.refVersions['service:refs/heads/alpha'] = updated.head_commit;
    state.relationships[0].from_revision = updated.id;
    state.relationships[0].id += '-v2';
    result = await deriveDecisionComponents(state);
    assert.equal(result.components[0].id, component.id);
    assert.equal(result.components[0].status, 'open');
    assert.notEqual(result.components[0].graph_hash, component.graph_hash);
    assert.ok(!result.components[0].revision_ids.includes(oldId));
  }
});

test('overlarge or expensive components remain explicit conventional review and never expose an incomplete option list', async () => {
  const state = fixture(['alpha', 'beta', 'gamma']);
  state.relationships.push(relation('alpha', 'beta'), relation('beta', 'gamma'));
  for (const options of [
    { maxImplementations: 2 },
    { maxSearchNodes: 1 },
    { maxAlternatives: 1 },
  ]) {
    const {
      components: [component],
      ungrouped_revision_ids,
    } = await deriveDecisionComponents(state, options);
    assert.equal(component.status, 'open');
    assert.equal(component.planning.status, 'manual-review');
    assert.deepEqual(component.alternatives, []);
    assert.deepEqual(ungrouped_revision_ids, []);
  }
});

test('a blocker between identical implementations remains an explicit unresolved claim', async () => {
  const state = fixture(['alpha', 'alias']);
  state.revisions[1].tree_hash = state.revisions[0].tree_hash;
  state.relationships.push(relation('alpha', 'alias'));
  const {
    components: [component],
  } = await deriveDecisionComponents(state);
  assert.equal(component.planning.status, 'manual-review');
  assert.match(component.planning.reason, /identical implementations/);
});

test('maximal search handles disconnected blocker structure without replacing maximality with size', () => {
  const result = maximalConsistentSubsets(
    ['a', 'b', 'c', 'd'],
    [
      ['a', 'b'],
      ['b', 'c'],
      ['b', 'd'],
    ],
  );
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.subsets, [['a', 'c', 'd'], ['b']]);
});

test('candidate enumeration agrees with exhaustive maximal independent sets over many small arbitrary graphs', () => {
  const keys = ['a', 'b', 'c', 'd', 'e', 'f'];
  for (let seed = 1; seed <= 32; seed++) {
    const pairs = [];
    let random = seed;
    for (let left = 0; left < keys.length; left++)
      for (let right = left + 1; right < keys.length; right++) {
        random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
        if (random % 3 === 0) pairs.push([keys[left], keys[right]]);
      }
    const independent = (selected) =>
      !pairs.some(([left, right]) => selected.includes(left) && selected.includes(right));
    const expected = [];
    for (let mask = 0; mask < 1 << keys.length; mask++) {
      const selected = keys.filter((_, index) => mask & (1 << index));
      if (
        independent(selected) &&
        keys.every((key) => selected.includes(key) || !independent([...selected, key]))
      )
        expected.push(selected);
    }
    expected.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    assert.deepEqual(maximalConsistentSubsets(keys, pairs).subsets, expected, `graph seed ${seed}`);
  }
});
