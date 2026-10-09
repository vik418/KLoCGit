import path from 'node:path';
import { DomainError } from '../../core/hash.mjs';

function configurationError(setting, requirement) {
  return new DomainError('INVALID_CONFIGURATION', `${setting} ${requirement}`, 503, { setting });
}

function configuredText(env, setting, defaultValue) {
  const value = env[setting] === undefined ? defaultValue : env[setting];
  if (typeof value !== 'string' || !value.trim())
    throw configurationError(setting, 'must be a nonblank string');
  return value;
}

function listenAddress(env, portSetting, hostSetting, defaultPort) {
  const value = env[portSetting] === undefined ? String(defaultPort) : env[portSetting];
  if (typeof value !== 'string' || !/^\d+$/.test(value))
    throw configurationError(portSetting, 'must be an integer from 0 to 65535');
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw configurationError(portSetting, 'must be an integer from 0 to 65535');

  // Port zero requests an OS-assigned port for isolated tests and local tooling.
  return {
    host: configuredText(env, hostSetting, '127.0.0.1'),
    port,
  };
}

/** Validate startup settings before the local adapter creates workspace files. */
export function localConfiguration(env, project) {
  const actor = env.LOCAL_ACTOR_ID;
  if (typeof actor !== 'string' || !actor.trim())
    throw new DomainError(
      'ACTOR_NOT_CONFIGURED',
      'Set LOCAL_ACTOR_ID to your development identity',
      503,
    );
  const address = listenAddress(env, 'PORT', 'HOST', 43187);
  const root =
    env.KLOCGIT_ROOT === undefined
      ? path.join(project, '.klocgit-workspace')
      : path.resolve(configuredText(env, 'KLOCGIT_ROOT'));
  return Object.freeze({
    root,
    actor,
    ownerToken: env.LOCAL_OWNER_TOKEN,
    ...address,
  });
}

/** Reject malformed listen settings before opening an executor manifest or cache. */
export function executorAddress(env) {
  return Object.freeze(listenAddress(env, 'GIT_EXECUTOR_PORT', 'GIT_EXECUTOR_HOST', 8788));
}
