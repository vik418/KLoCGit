import { DomainError } from '../core/hash.mjs';

const validName = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;
const supportedProfiles = ['checkout-effects-v2', 'context-document-v1'];

async function createRepository(engine, env, input, actor) {
  const created = await env.ARTIFACTS.create(input.name, {
    description: String(input.description ?? ''),
    setDefaultBranch: 'main',
  });
  await engine.audit('repository.created', actor, { repo: input.name });
  await engine.save(engine.state);
  return {
    name: created.name,
    remote: created.remote,
    needs_initial_commit: true,
    instruction:
      'Push an initial main commit using a separately provisioned scoped Git token, then register this repository without create:true.',
  };
}

async function repositoryInfo(env, name) {
  const capability = await env.ARTIFACTS.get(name);
  try {
    return await capability.info();
  } finally {
    capability[Symbol.dispose]?.();
  }
}

async function trustedProfile(engine, input) {
  if (input.validation_profile && !supportedProfiles.includes(input.validation_profile)) {
    throw new DomainError(
      'VALIDATION_PROFILE_UNSUPPORTED',
      'Use a supported trusted profile or leave the repository in conventional review',
    );
  }
  if (!input.validation_profile) return { validation_profile: null, context_repo: null };

  const profile = await engine.git.profile({ id: input.name });
  if (
    profile.validation_profile !== input.validation_profile ||
    (input.context_repo && profile.context_repo !== input.context_repo)
  ) {
    throw new DomainError(
      'VALIDATION_PROFILE_MISMATCH',
      'Registered validation must match the trusted executor manifest',
      409,
    );
  }
  return profile;
}

export async function registerRepository(engine, env, input, actor) {
  const name = input.name;
  if (!validName.test(name ?? ''))
    throw new DomainError('INVALID_REPO', 'Use a valid repository name');
  if (engine.state.repositories.some((repo) => repo.id === name)) {
    throw new DomainError('REPO_EXISTS', 'Repository is already registered', 409);
  }
  if (input.create) return createRepository(engine, env, input, actor);

  const info = await repositoryInfo(env, name);
  const profile = await trustedProfile(engine, input);
  if (profile.context_repo) engine.repo(profile.context_repo);
  const repo = {
    id: name,
    name,
    canonical_ref: 'refs/heads/' + info.defaultBranch,
    provider: 'cloudflare-artifacts',
    remote: info.remote,
    validation_profile: profile.validation_profile,
    context_repo: profile.context_repo,
  };
  const head = await engine.git.ref(repo, repo.canonical_ref);
  Object.assign(repo, { head, baseline: head });
  engine.state.repositories.push(repo);
  await engine.audit('repository.registered', actor, {
    repo: name,
    head,
    validation_profile: repo.validation_profile,
    context_repo: repo.context_repo,
  });
  await engine.save(engine.state);
  return repo;
}

export async function forkRepository(engine, env, input, actor) {
  const source = engine.repo(input.source);
  if (!validName.test(input.name ?? ''))
    throw new DomainError('INVALID_REPO', 'Use a valid fork name');
  const capability = await env.ARTIFACTS.get(source.id);
  let result;
  try {
    result = await capability.fork(input.name, {
      description: String(input.description ?? ''),
      defaultBranchOnly: true,
    });
  } finally {
    capability[Symbol.dispose]?.();
  }
  engine.state.forks.push({ id: result.name, repo: source.id, base_commit: source.head });
  await engine.audit('repository.forked', actor, { source: source.id, fork: result.name });
  await engine.save(engine.state);
  // Artifacts mints a scoped token; it is never returned as coordination data.
  return {
    id: result.id,
    name: result.name,
    remote: result.remote,
    defaultBranch: result.defaultBranch,
  };
}
