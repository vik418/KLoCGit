import { DomainError, hash, record } from './hash.mjs';

const oid = /^(?!0{40}$)[a-f0-9]{40}$/;
const now = () => new Date().toISOString();
const clone = (value) => structuredClone(value);

function text(value, label, limit = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit)
    throw new DomainError('INVALID_CONTEXT_INPUT', label + ' must be bounded, nonempty text');
  return value.trim();
}

function pathInput(value) {
  const path = text(value, 'Context path', 500);
  if (
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes(':') ||
    path.split('/').some((part) => !part || part === '.' || part === '..') ||
    /[\u0000-\u001f\u007f]/.test(path) ||
    /(^|\/)(\.env(?:\..*)?|\.git|\.ssh|secrets?|credentials?)(\/|$)/i.test(path) ||
    /\.(?:pem|key|p12|pfx)$/i.test(path)
  )
    throw new DomainError('INVALID_CONTEXT_PATH', 'Use a literal, non-secret repository file path');
  return path;
}

function refInput(value) {
  const ref = text(value, 'Context ref', 200);
  if (
    !ref.startsWith('refs/heads/') ||
    ref.endsWith('/') ||
    ref.endsWith('.') ||
    ref.includes('..') ||
    ref.includes('@{') ||
    ref.includes('//') ||
    /[\u0000-\u0020\u007f~^:?*\[\\]/.test(ref) ||
    ref.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock'))
  )
    throw new DomainError('INVALID_REF', 'Context retrieval requires a literal branch ref');
  return ref;
}

function overlap(left, right) {
  return left === right || left.startsWith(right + '/') || right.startsWith(left + '/');
}

function scopes(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100)
    throw new DomainError('INVALID_CONTEXT_INPUT', 'Context scope must be a bounded list');
  return value.map((entry) => {
    if (typeof entry === 'string') return { path: pathInput(entry) };
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new DomainError('INVALID_CONTEXT_INPUT', 'Context scope entries must name a path');
    return {
      ...(entry.repo_id === undefined ? {} : { repo_id: text(entry.repo_id, 'Repository', 200) }),
      path: pathInput(entry.path),
    };
  });
}

function relevant(value, objective, system) {
  const repoIds = system.repository_refs.map((entry) => entry.repo_id);
  if (value.repo_id && !repoIds.includes(value.repo_id)) return false;
  const scope = scopes(value.scope ?? value.validity_scope ?? []);
  if (!scope.length) return true;
  const inSystem = scope.filter((entry) => !entry.repo_id || repoIds.includes(entry.repo_id));
  if (!inSystem.length) return false;
  return (
    !objective.scope.length ||
    inSystem.some((entry) => objective.scope.some((path) => overlap(entry.path, path)))
  );
}

function withoutTimes(value) {
  if (Array.isArray(value)) return value.map(withoutTimes);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'created_at')
        .map(([key, entry]) => [key, withoutTimes(entry)]),
    );
  return value;
}

async function immutable(prefix, value) {
  return record(prefix, {
    ...value,
    id: prefix + '_' + (await hash(withoutTimes(value))),
    created_at: now(),
  });
}

function choiceInput(value) {
  if (!value) return null;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !Array.isArray(value.options) ||
    value.options.length < 2 ||
    value.options.length > 8
  )
    throw new DomainError('INVALID_CONTEXT_SOURCE', 'A choice needs two to eight explicit options');
  const options = value.options.map((option) => {
    if (
      !option ||
      !Array.isArray(option.effects) ||
      !option.effects.length ||
      option.effects.length > 20
    )
      throw new DomainError(
        'INVALID_CONTEXT_SOURCE',
        'Options must describe their material effects',
      );
    return {
      id: text(option.id, 'Option identity', 100),
      label: text(option.label, 'Option label', 200),
      effects: option.effects.map((effect) => text(effect, 'Declared option effect', 500)),
    };
  });
  if (new Set(options.map((option) => option.id)).size !== options.length)
    throw new DomainError('INVALID_CONTEXT_SOURCE', 'Choice option identities must be unique');
  return {
    key: text(value.key, 'Choice key', 100),
    question: text(value.question, 'Clarification', 500),
    options,
  };
}

/**
 * Explicit context sources are data. Only coordination-visible JSON fields are
 * projected; raw files, prompts, credentials and arbitrary metadata stay in Git.
 * Choice annotations describe uncertainty, not a trusted executable policy.
 */
function projectDocument(content, path) {
  if (!path.endsWith('.json')) return [];
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  const documents = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      ? [
          ...(Array.isArray(parsed.constraints) ? parsed.constraints : []),
          ...(Array.isArray(parsed.decisions) ? parsed.decisions : []),
          ...(parsed.visibility === 'coordination' ? [parsed] : []),
        ]
      : [];
  if (documents.length > 50)
    throw new DomainError(
      'INVALID_CONTEXT_SOURCE',
      'A source can expose at most fifty context records',
    );
  return documents
    .filter((value) => value?.visibility === 'coordination')
    .map((value) => ({
      source_key: text(value.id, 'Context record identity', 200),
      version: text(String(value.version ?? ''), 'Context record version', 100),
      type: value.type === 'decision' ? 'decision' : 'constraint',
      statement: text(value.statement, 'Context statement'),
      scope: scopes(value.scope ?? value.validity_scope),
      ...(value.kind === undefined
        ? {}
        : { kind: value.kind === 'checkable' ? 'checkable' : 'advisory' }),
      choice: choiceInput(value.choice),
    }));
}

/** Context preparation is optional and does not prevent ordinary Git ingestion. */
export class NativeContext {
  constructor(engine) {
    this.engine = engine;
  }

  get state() {
    for (const key of [
      'nativeContextPreparations',
      'nativeContextSnapshots',
      'nativeContextResolutions',
    ])
      this.engine.state[key] ??= [];
    return this.engine.state;
  }

  object(collection, id) {
    const value = this.state[collection].find((entry) => entry.id === id);
    if (!value) throw new DomainError('CONTEXT_NOT_FOUND', 'Context record not found', 404);
    return value;
  }

  async applicable(objective) {
    const system = this.engine.native.system(objective.system_id);
    const constraints = [];
    for (const value of this.state.constraints.filter((entry) => entry.active)) {
      if (!relevant(value, objective, system)) continue;
      constraints.push({
        id: value.id,
        version_hash: await hash(value),
        statement: value.statement,
        kind: value.kind,
        scope: scopes(value.scope ?? value.validity_scope),
        choice: choiceInput(value.choice),
      });
    }
    const decisions = [];
    for (const decision of this.state.nativeDecisions ?? []) {
      const candidate = this.state.candidateStates?.find(
        (entry) => entry.id === decision.candidate_id,
      );
      if (!candidate) continue;
      const objectives = candidate.selection_ids.flatMap((id) => {
        const selection = this.state.selections?.find((entry) => entry.id === id);
        const revision = this.state.futureRevisions.find(
          (entry) => entry.id === selection?.future_revision_id,
        );
        const future = this.state.futures.find((entry) => entry.id === revision?.future_id);
        return future ? [this.engine.native.objective(future.objective_id)] : [];
      });
      if (
        !objectives.some(
          (entry) =>
            entry.system_id === system.id &&
            (!entry.scope.length ||
              !objective.scope.length ||
              entry.scope.some((path) => objective.scope.some((other) => overlap(path, other)))),
        )
      )
        continue;
      const operation = this.state.operations.find((entry) => entry.decision_id === decision.id);
      decisions.push({
        id: decision.id,
        version_hash: await hash(decision),
        resolution: decision.resolution,
        application_state: operation?.status ?? 'unknown',
        rationale: decision.rationale,
        candidate_id: candidate.id,
      });
    }
    return {
      constraints: constraints.sort((a, b) => a.id.localeCompare(b.id)),
      decisions: decisions.sort((a, b) => a.id.localeCompare(b.id)),
    };
  }

  async sources(input) {
    if (!Array.isArray(input) || input.length > 20)
      throw new DomainError('INVALID_CONTEXT_INPUT', 'Choose at most twenty context source files');
    const result = input.map((source) => {
      if (!source || typeof source !== 'object' || Array.isArray(source))
        throw new DomainError('INVALID_CONTEXT_INPUT', 'Context sources must be file references');
      const repo = this.engine.repo(text(source.repo_id, 'Repository', 200));
      return {
        repo_id: repo.id,
        path: pathInput(source.path),
        ref: refInput(source.ref ?? repo.canonical_ref),
      };
    });
    const keys = result.map((entry) => JSON.stringify(entry));
    if (new Set(keys).size !== keys.length)
      throw new DomainError('INVALID_CONTEXT_INPUT', 'Context source files must be unique');
    return result.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }

  async readSource(input) {
    if (typeof this.engine.git.file !== 'function')
      throw new DomainError(
        'CONTEXT_RETRIEVAL_UNAVAILABLE',
        'The Git adapter cannot read pinned files',
        503,
      );
    const repo = this.engine.repo(input.repo_id);
    const commit = await this.engine.git.ref(repo, input.ref);
    if (!oid.test(commit))
      throw new DomainError('INVALID_GIT_FACTS', 'Context requires an immutable commit', 503);
    const facts = await this.engine.git.facts(repo, commit, commit);
    if (facts.head !== commit || !oid.test(facts.tree))
      throw new DomainError(
        'INVALID_GIT_FACTS',
        'Context requires an observed immutable tree',
        503,
      );
    const content = await this.engine.git.file(repo, commit, input.path);
    if (typeof content !== 'string' || content.length > 65536 || content.includes('\u0000'))
      throw new DomainError(
        'CONTEXT_SOURCE_UNAVAILABLE',
        'Context source must be a bounded text file',
        409,
      );
    const source = await immutable('native_context_source', {
      ...input,
      commit,
      tree: facts.tree,
      content_hash: await hash(content),
    });
    return { source, documents: projectDocument(content, input.path) };
  }

  async prepare(objectiveId, input, actor) {
    const objective = this.engine.native.objective(objectiveId);
    const sourceInputs = await this.sources(input.sources ?? []);
    const hypothesis =
      input.hypothesis === undefined || input.hypothesis === ''
        ? null
        : { label: text(input.hypothesis, 'Approach name', 100), basis: 'declared', actor };
    return this.engine.native.request(
      'context.prepare',
      {
        objective_id: objective.id,
        sources: sourceInputs,
        hypothesis,
        request_id: input.request_id,
      },
      actor,
      async () => {
        const system = this.engine.native.system(objective.system_id);
        const reads = [];
        for (const source of sourceInputs) reads.push(await this.readSource(source));
        const applicable = await this.applicable(objective);
        const items = [
          await immutable('native_context_item', {
            type: 'objective',
            basis: objective.source?.basis === 'declared' ? 'declared' : 'unknown',
            value: { objective_id: objective.id },
            source: { objective_id: objective.id },
            validity_scope: scopes(objective.scope),
          }),
        ];
        const rules = [];
        for (const { source, documents } of reads) {
          items.push(
            await immutable('native_context_item', {
              type: 'git-state',
              basis: 'observed',
              value: {
                repo_id: source.repo_id,
                ref: source.ref,
                commit: source.commit,
                tree: source.tree,
              },
              source: { source_id: source.id },
              validity_scope: [],
            }),
          );
          items.push(
            await immutable('native_context_item', {
              type: 'source',
              basis: 'retrieved',
              value: { path: source.path, content_hash: source.content_hash },
              source: {
                source_id: source.id,
                repo_id: source.repo_id,
                commit: source.commit,
                tree: source.tree,
              },
              validity_scope: [],
            }),
          );
          for (const document of documents.filter((entry) => relevant(entry, objective, system))) {
            items.push(
              await immutable('native_context_item', {
                type: document.type,
                basis: 'retrieved',
                value: document,
                source: {
                  source_id: source.id,
                  source_key: document.source_key,
                  version: document.version,
                },
                validity_scope: document.scope,
              }),
            );
            if (document.choice)
              rules.push({ ...document, source_id: source.id, basis: 'retrieved' });
          }
        }
        for (const constraint of applicable.constraints) {
          items.push(
            await immutable('native_context_item', {
              type: 'constraint',
              basis: 'retrieved',
              value: constraint,
              source: { constraint_id: constraint.id, version_hash: constraint.version_hash },
              validity_scope: constraint.scope,
            }),
          );
          if (constraint.choice)
            rules.push({ ...constraint, source_id: constraint.id, basis: 'retrieved' });
        }
        for (const decision of applicable.decisions)
          items.push(
            await immutable('native_context_item', {
              type: 'decision',
              basis: 'retrieved',
              value: decision,
              source: { decision_id: decision.id, version_hash: decision.version_hash },
              validity_scope: scopes(objective.scope),
            }),
          );
        if (hypothesis)
          items.push(
            await immutable('native_context_item', {
              type: 'hypothesis',
              basis: 'declared',
              value: hypothesis,
              source: { actor },
              validity_scope: scopes(objective.scope),
            }),
          );
        const questions = [];
        for (const rule of rules) {
          const signatures = await Promise.all(
            rule.choice.options.map((option) => hash([...new Set(option.effects)].sort())),
          );
          if (new Set(signatures).size < 2) continue;
          const question = await immutable('native_context_question', {
            ...rule.choice,
            basis: 'inferred',
            rule: 'distinct-declared-effects-v0',
            source_id: rule.source_id,
            rationale:
              'The source describes materially different option effects; no preference is inferred.',
          });
          if (!questions.some((entry) => entry.id === question.id)) questions.push(question);
        }
        const value = {
          objective_id: objective.id,
          objective_hash: await hash(objective),
          hypothesis,
          sources: reads.map((entry) => entry.source),
          applicable,
          items,
          questions,
          limitations: [
            'Clarifications require explicit option/effect annotations; arbitrary prose is not semantically interpreted.',
            'Retrieved policy claims are not trusted executable checks.',
          ],
        };
        const preparation = await immutable('native_context_preparation', {
          ...value,
          basis_hash: await hash(withoutTimes(value)),
        });
        const validity = await this.validityOf(preparation);
        if (validity.status !== 'current')
          throw new DomainError('CONTEXT_STALE', 'Context changed during retrieval', 409);
        if (!this.state.nativeContextPreparations.some((entry) => entry.id === preparation.id))
          this.state.nativeContextPreparations.push(preparation);
        let snapshot = null;
        if (!questions.length) snapshot = await this.snapshot(preparation, [], actor);
        await this.engine.native.event('context.prepared', actor, {
          objective_id: objective.id,
          preparation_id: preparation.id,
          question_count: questions.length,
        });
        return { preparation, snapshot };
      },
    );
  }

  async validityOf(value) {
    const objective = this.engine.native.objective(value.objective_id);
    const reasons = [];
    if ((await hash(objective)) !== value.objective_hash) reasons.push('Objective changed');
    const current = await this.applicable(objective);
    if ((await hash(current.constraints)) !== (await hash(value.applicable.constraints)))
      reasons.push('Relevant constraint version changed');
    // New decisions are discoverable on the next preparation. They do not
    // invalidate their own source context while a promotion journal is prepared.
    for (const decision of value.applicable.decisions) {
      const stored = this.state.nativeDecisions?.find((entry) => entry.id === decision.id);
      if (!stored || (await hash(stored)) !== decision.version_hash)
        reasons.push('Referenced decision version changed');
    }
    for (const source of value.sources) {
      const repo = this.engine.repo(source.repo_id);
      const commit = await this.engine.git.ref(repo, source.ref);
      if (commit !== source.commit) {
        reasons.push('Context source ref changed: ' + source.repo_id);
        continue;
      }
      const content = await this.engine.git.file(repo, source.commit, source.path);
      if (typeof content !== 'string' || (await hash(content)) !== source.content_hash)
        reasons.push('Context source content unavailable: ' + source.repo_id);
    }
    return { status: reasons.length ? 'stale' : 'current', reasons };
  }

  async validity(snapshotId) {
    const snapshot = this.object('nativeContextSnapshots', snapshotId);
    return this.validityOf(this.object('nativeContextPreparations', snapshot.preparation_id));
  }

  async revisionsValidity(revisionIds) {
    const snapshots = [];
    let unknown = 0;
    for (const revisionId of [...new Set(revisionIds)]) {
      const revision = this.engine.native.revision(revisionId);
      if (!revision.context_snapshot) {
        unknown++;
        continue;
      }
      const snapshot = this.object('nativeContextSnapshots', revision.context_snapshot);
      if (!snapshots.some((entry) => entry.id === snapshot.id))
        snapshots.push({
          id: snapshot.id,
          basis_hash: snapshot.basis_hash,
          assumption_refs: [...snapshot.assumption_refs],
          validity: await this.validity(snapshot.id),
        });
    }
    return {
      status: snapshots.some((entry) => entry.validity.status !== 'current') ? 'stale' : 'current',
      snapshots,
      unknown_revision_count: unknown,
      requires_human_judgment:
        unknown > 0 || snapshots.some((entry) => entry.assumption_refs.length),
    };
  }

  async snapshot(preparation, resolutions, actor) {
    const value = await immutable('native_context_snapshot', {
      objective_id: preparation.objective_id,
      preparation_id: preparation.id,
      basis_hash: preparation.basis_hash,
      hypothesis: preparation.hypothesis,
      item_ids: preparation.items.map((item) => item.id),
      source_refs: preparation.sources.map((source) => source.id),
      resolutions,
      assumption_refs: resolutions
        .filter((entry) => entry.type === 'assumption')
        .map((entry) => entry.id),
      created_by: actor,
    });
    if (!this.state.nativeContextSnapshots.some((entry) => entry.id === value.id))
      this.state.nativeContextSnapshots.push(value);
    return value;
  }

  async resolve(preparationId, input, actor) {
    const preparation = this.object('nativeContextPreparations', preparationId);
    const mode = input.mode;
    const expectedBasis = input.expected_basis_hash;
    if (
      !['answer', 'assumption'].includes(mode) ||
      !input.answers ||
      typeof input.answers !== 'object' ||
      Array.isArray(input.answers)
    )
      throw new DomainError(
        'INVALID_CONTEXT_ANSWER',
        'Answer questions or record explicit assumptions',
      );
    const answers = {};
    for (const question of preparation.questions) {
      const answer = input.answers[question.id];
      if (!question.options.some((option) => option.id === answer))
        throw new DomainError(
          'INVALID_CONTEXT_ANSWER',
          'Choose an explicit option for every material question',
        );
      answers[question.id] = answer;
    }
    if (
      !preparation.questions.length ||
      Object.keys(input.answers).length !== preparation.questions.length
    )
      throw new DomainError(
        'INVALID_CONTEXT_ANSWER',
        'Answers must match the preparation questions',
      );
    const rationale =
      mode === 'assumption'
        ? text(input.rationale, 'Assumption rationale')
        : input.rationale === undefined || input.rationale === ''
          ? ''
          : text(input.rationale, 'Answer rationale');
    return this.engine.native.request(
      'context.resolve',
      {
        preparation_id: preparation.id,
        expected_basis_hash: expectedBasis,
        mode,
        answers,
        rationale,
        request_id: input.request_id,
      },
      actor,
      async () => {
        if (
          this.state.nativeContextResolutions.some(
            (entry) => entry.preparation_id === preparation.id,
          )
        )
          throw new DomainError(
            'CONTEXT_ALREADY_RESOLVED',
            'Prepare a new context rather than rewriting an answer',
            409,
          );
        if (
          expectedBasis !== preparation.basis_hash ||
          (await this.validityOf(preparation)).status !== 'current'
        )
          throw new DomainError(
            'CONTEXT_STALE',
            'Review the changed context before answering',
            409,
          );
        const resolutions = [];
        for (const question of preparation.questions)
          resolutions.push(
            await immutable('native_context_item', {
              type: mode,
              basis: 'declared',
              value: { key: question.key, option_id: answers[question.id], rationale },
              source: { question_id: question.id, actor },
              validity_scope: this.engine.native.objective(preparation.objective_id).scope,
              unresolved_truth: mode === 'assumption',
            }),
          );
        const snapshot = await this.snapshot(preparation, resolutions, actor);
        const resolution = await immutable('native_context_resolution', {
          preparation_id: preparation.id,
          snapshot_id: snapshot.id,
          mode,
          actor,
        });
        this.state.nativeContextResolutions.push(resolution);
        await this.engine.native.event(
          mode === 'assumption' ? 'context.assumed' : 'context.answered',
          actor,
          {
            objective_id: preparation.objective_id,
            snapshot_id: snapshot.id,
            resolution_id: resolution.id,
          },
        );
        return { preparation, snapshot, resolution };
      },
    );
  }

  async review(preparationId) {
    const preparation = this.object('nativeContextPreparations', preparationId);
    const resolution = this.state.nativeContextResolutions.find(
      (entry) => entry.preparation_id === preparation.id,
    );
    const snapshot = resolution
      ? this.object('nativeContextSnapshots', resolution.snapshot_id)
      : (this.state.nativeContextSnapshots.find(
          (entry) => entry.preparation_id === preparation.id,
        ) ?? null);
    return { preparation, snapshot, validity: await this.validityOf(preparation) };
  }

  async bindFuture(objective, snapshotId) {
    if (!snapshotId)
      return {
        context_snapshot: null,
        context_binding_state: 'unknown',
        context_assumption_refs: [],
      };
    const snapshot = this.object('nativeContextSnapshots', snapshotId);
    if (snapshot.objective_id !== objective.id)
      throw new DomainError(
        'CONTEXT_OBJECTIVE_MISMATCH',
        'The context belongs to a different Objective',
        409,
      );
    if ((await this.validity(snapshot.id)).status !== 'current')
      throw new DomainError(
        'CONTEXT_STALE',
        'Prepare current context before creating a Future',
        409,
      );
    return {
      context_snapshot: snapshot.id,
      context_binding_state: 'bound',
      context_assumption_refs: [...snapshot.assumption_refs],
    };
  }

  provenanceForRevision(revision) {
    if (!revision.context_snapshot)
      return {
        context_state: 'unknown',
        objective_id:
          this.state.futures.find((future) => future.id === revision.future_id)?.objective_id ??
          null,
      };
    const snapshot = this.object('nativeContextSnapshots', revision.context_snapshot);
    return {
      context_state: 'bound',
      objective_id: snapshot.objective_id,
      snapshot_id: snapshot.id,
      assumption_refs: [...snapshot.assumption_refs],
    };
  }

  /** Export references and approved coordination fields; never source file bodies. */
  export(systemId) {
    const system = this.engine.native.system(systemId);
    const objectiveIds = this.state.objectives
      .filter((entry) => entry.system_id === system.id)
      .map((entry) => entry.id);
    const preparations = this.state.nativeContextPreparations.filter((entry) =>
      objectiveIds.includes(entry.objective_id),
    );
    return clone({
      version: 0,
      system_id: system.id,
      preparations,
      snapshots: this.state.nativeContextSnapshots.filter((entry) =>
        objectiveIds.includes(entry.objective_id),
      ),
      resolutions: this.state.nativeContextResolutions.filter((entry) =>
        preparations.some((preparation) => preparation.id === entry.preparation_id),
      ),
      limitations: [
        'Source content and raw producer metadata are excluded. Coordination-visible statements remain sensitive data.',
      ],
    });
  }

  search({ system_id: systemId, query, limit = 20 }) {
    const value = this.export(systemId);
    const phrase = text(query, 'Search query', 200).toLowerCase();
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new DomainError('INVALID_CONTEXT_INPUT', 'Search limit must be one to one hundred');
    return value.preparations
      .flatMap((preparation) =>
        preparation.items
          .filter((item) =>
            JSON.stringify({ type: item.type, value: item.value, source: item.source })
              .toLowerCase()
              .includes(phrase),
          )
          .map((item) => ({
            item,
            objective_id: preparation.objective_id,
            preparation_id: preparation.id,
          })),
      )
      .slice(0, limit);
  }

  trace({ kind, id, repo_id: repoId }) {
    const revisions = new Map();
    const selections = [];
    const candidates = [];
    const decisions = [];
    const addRevision = (revisionId) => {
      const revision = this.engine.native.revision(revisionId);
      revisions.set(revision.id, revision);
    };
    const addSelection = (selectionId) => {
      const selection = this.state.selections?.find((entry) => entry.id === selectionId);
      if (!selection) throw new DomainError('NOT_FOUND', 'Selection not found', 404);
      if (!selections.some((entry) => entry.id === selection.id))
        selections.push({ id: selection.id, kind: selection.kind, entries: selection.entries });
      addRevision(selection.future_revision_id);
    };
    const addCandidate = (candidateId) => {
      const candidate = this.state.candidateStates?.find((entry) => entry.id === candidateId);
      if (!candidate) throw new DomainError('NOT_FOUND', 'Candidate not found', 404);
      if (!candidates.some((entry) => entry.id === candidate.id))
        candidates.push({ id: candidate.id, repositories: candidate.repositories });
      candidate.selection_ids.forEach(addSelection);
    };
    const addDecision = (decision) => {
      if (!decisions.some((entry) => entry.id === decision.id))
        decisions.push({
          id: decision.id,
          resolution: decision.resolution,
          rationale: decision.rationale,
          actor: decision.actor,
          decision_basis_hash: decision.decision_basis_hash,
        });
      addCandidate(decision.candidate_id);
    };
    if (kind === 'code') {
      this.engine.repo(text(repoId, 'Repository', 200));
      if (!oid.test(id))
        throw new DomainError(
          'INVALID_CONTEXT_INPUT',
          'Code trace requires an exact commit or tree',
        );
      const matching =
        this.state.candidateStates?.filter((candidate) =>
          candidate.repositories.some(
            (repo) => repo.repo_id === repoId && (repo.commit === id || repo.tree === id),
          ),
        ) ?? [];
      matching.forEach((candidate) => {
        addCandidate(candidate.id);
        (this.state.nativeDecisions ?? [])
          .filter((decision) => decision.candidate_id === candidate.id)
          .forEach(addDecision);
      });
      for (const revision of this.state.futureRevisions)
        if (
          revision.repository_heads.some((head) => head.repo_id === repoId && head.commit === id) ||
          revision.tree_hashes.some((tree) => tree.repo_id === repoId && tree.tree === id)
        )
          addRevision(revision.id);
    } else if (kind === 'objective') {
      this.engine.native.objective(id);
      const futureIds = this.state.futures
        .filter((future) => future.objective_id === id)
        .map((future) => future.id);
      const revisionIds = this.state.futureRevisions
        .filter((revision) => futureIds.includes(revision.future_id))
        .map((revision) => revision.id);
      revisionIds.forEach(addRevision);
      const selectionIds = (this.state.selections ?? [])
        .filter((selection) => revisionIds.includes(selection.future_revision_id))
        .map((selection) => selection.id);
      selectionIds.forEach(addSelection);
      (this.state.candidateStates ?? [])
        .filter((candidate) =>
          candidate.selection_ids.some((selectionId) => selectionIds.includes(selectionId)),
        )
        .forEach((candidate) => {
          addCandidate(candidate.id);
          (this.state.nativeDecisions ?? [])
            .filter((decision) => decision.candidate_id === candidate.id)
            .forEach(addDecision);
        });
    } else if (kind === 'revision') addRevision(id);
    else if (kind === 'selection') addSelection(id);
    else if (kind === 'candidate') addCandidate(id);
    else if (kind === 'decision') {
      const decision = this.state.nativeDecisions?.find((entry) => entry.id === id);
      if (!decision) throw new DomainError('NOT_FOUND', 'Decision not found', 404);
      addDecision(decision);
    } else
      throw new DomainError(
        'INVALID_CONTEXT_INPUT',
        'Trace code, an Objective, revision, selection, candidate or decision',
      );
    const snapshots = [
      ...new Set(
        [...revisions.values()].map((revision) => revision.context_snapshot).filter(Boolean),
      ),
    ].map((snapshotId) => this.object('nativeContextSnapshots', snapshotId));
    return clone({
      version: 0,
      revisions: [...revisions.values()].map((revision) => ({
        id: revision.id,
        future_id: revision.future_id,
        repository_heads: revision.repository_heads,
        tree_hashes: revision.tree_hashes,
        provenance_state: revision.provenance_state,
        ...this.provenanceForRevision(revision),
      })),
      selections,
      candidates,
      decisions,
      snapshots,
      preparations: snapshots.map((snapshot) =>
        this.object('nativeContextPreparations', snapshot.preparation_id),
      ),
      code_provenance: selections.flatMap((selection) =>
        selection.entries.map((entry) => ({
          selection_id: selection.id,
          repo_id: entry.repo_id,
          source_repo: entry.source_repo,
          head_commit: entry.head_commit,
          selected_commits: entry.commits,
          basis: 'observed',
          claim:
            'Git source selection; semantic authorship and dependency closure are not established.',
        })),
      ),
    });
  }

  view() {
    return clone({
      contextPreparations: this.state.nativeContextPreparations,
      contextSnapshots: this.state.nativeContextSnapshots,
      contextResolutions: this.state.nativeContextResolutions,
    });
  }
}
