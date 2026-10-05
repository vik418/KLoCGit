import { DomainError } from '../core/hash.mjs';

const validName = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;
const supportedProfiles = ['checkout-effects-v0', 'context-document-v0'];

async function createRepository(engine, input, actor) {
  // Share the native journal so acknowledgement loss cannot create a second repo.
  const { repository } = await engine.native.registerRepository(
    {
      id: input.name,
      mode: 'create',
      description: input.description,
      request_id: input.request_id,
    },
    actor,
  );
  return {
    name: repository.id,
    remote: repository.remote,
    needs_initial_commit: repository.status === 'empty',
    instruction:
      'Push an initial main commit using a separately provisioned scoped Git token, then refresh the repository Git state.',
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
  if (input.create) return createRepository(engine, input, actor);
  if (engine.state.repositories.some((repo) => repo.id === name)) {
    throw new DomainError('REPO_EXISTS', 'Repository is already registered', 409);
  }

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

export async function forkRepository() {
  throw new DomainError(
    'NATIVE_FUTURE_REQUIRED',
    'Create an isolated Future through POST /api/futures; repository forks require its durable journal and exact baseline.',
    409,
  );
}
