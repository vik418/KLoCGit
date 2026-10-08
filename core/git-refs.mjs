import { DomainError } from './hash.mjs';

export const gitObjectId = /^(?!0{40}$|0{64}$)[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

/** Only ordinary branches and tags are producer-selectable; internal refs stay private. */
export function observationRef(value) {
  if (
    typeof value !== 'string' ||
    value.length > 255 ||
    !/^refs\/(heads|tags)\/.+/.test(value) ||
    /[\x00-\x20\x7f~^:?*\[\\]/.test(value) ||
    value.includes('..') ||
    value.includes('@{') ||
    value.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))
  )
    throw new DomainError('INVALID_REF', 'Use a valid full branch or tag ref');
  return value;
}

export function refPage(input = {}) {
  const limit = input.limit === undefined ? 100 : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new DomainError('INVALID_REF_PAGE', 'Ref pages contain 1 to 200 entries');
  return { limit, cursor: input.cursor ? observationRef(input.cursor) : '' };
}

export function pageRefs(refs, input = {}) {
  const { limit, cursor } = refPage(input);
  if (!Array.isArray(refs) || refs.length > 1000)
    throw new DomainError('REF_BUDGET', 'More than 1000 refs require asynchronous enumeration', 422);
  const eligible = refs.filter((entry) => entry.ref > cursor).sort((a, b) => a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);
  const page = eligible.slice(0, limit);
  return { refs: page, has_more: eligible.length > limit, next_cursor: eligible.length > limit ? page.at(-1).ref : null };
}
