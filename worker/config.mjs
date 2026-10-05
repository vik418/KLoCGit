import { DomainError } from '../core/hash.mjs';

export function configuredWorkspace(env) {
  const id = env?.WORKSPACE_ID;
  if (typeof id !== 'string' || !id.trim()) {
    throw new DomainError(
      'WORKSPACE_NOT_CONFIGURED',
      'Configure a nonblank WORKSPACE_ID before using this Worker.',
      503,
    );
  }
  return id;
}
