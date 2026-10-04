import { asArray } from './workspace.js';

export function getErrorReasons(value) {
  return asArray(value).map((reason) =>
    typeof reason === 'string'
      ? reason
      : (reason.message ?? reason.reason ?? reason.code ?? JSON.stringify(reason)),
  );
}

export function getErrorMessage(error) {
  return [
    error.message ?? error.error ?? 'The operation failed.',
    ...getErrorReasons(error.details?.reasons),
  ].join(' ');
}
