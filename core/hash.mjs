/**
 * Encode inputs in the historical format that existing record IDs depend on.
 * Object keys are sorted and undefined object fields are omitted. Array order
 * and the existing join behavior for undefined array entries are preserved.
 *
 * @param {unknown} value Acyclic record input.
 * @returns {string | undefined} Stable encoding; a top-level undefined remains undefined.
 */
export function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined);
    const fields = keys.map((key) => `${JSON.stringify(key)}:${stable(value[key])}`);
    return `{${fields.join(',')}}`;
  }
  return JSON.stringify(value);
}
/**
 * Hash the stable encoding so object key insertion order cannot change a version.
 *
 * @param {unknown} value Inputs accepted by stable().
 * @returns {Promise<string>} Lowercase SHA-256 digest of the UTF-8 input encoding.
 */
export async function hash(value) {
  const data = new TextEncoder().encode(stable(value));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
/**
 * Hash the input fields, then clone and freeze the snapshot so later caller edits
 * cannot rewrite its history. Caller fields retain spread precedence, including
 * an existing id; omit data.id when creating a new content-addressed identity.
 *
 * @param {string} prefix Namespace prefix for the generated identity.
 * @param {object} data Plain coordination metadata to snapshot.
 * @returns {Promise<object>} Frozen record detached from the original input references.
 */
export async function record(prefix, data) {
  return deepFreeze({ id: `${prefix}_${await hash(data)}`, ...structuredClone(data) });
}
export class DomainError extends Error {
  constructor(code, message, status = 400, details = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
