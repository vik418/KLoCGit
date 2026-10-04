/** Stable record input encoding: sort object keys, omit undefined fields, preserve array order. */
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
/** Create a frozen snapshot without retaining mutable references to its input. */
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
