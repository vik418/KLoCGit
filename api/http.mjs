import { publicError } from '../core/v1/conventions.mjs';

const status = {
  AUTHORIZATION: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INCOMPLETE: 409,
  POLICY: 409,
  VALIDATION: 400,
  UNSUPPORTED: 422,
  INTEGRITY: 422,
  TRANSIENT: 503,
  AMBIGUOUS: 503,
  INTERNAL: 500,
};

export const PRIVATE_JSON_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'content-type': 'application/json',
});

export function errorResponse(error, headers = PRIVATE_JSON_HEADERS) {
  const failure = publicError(error);
  return Response.json(
    { schema_version: 1, error: failure },
    { status: failure.code === 'UNAUTHENTICATED' ? 401 : status[failure.failure_class], headers },
  );
}
