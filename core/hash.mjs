export function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>`${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export async function hash(value) {
  const data = new TextEncoder().encode(stable(value));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
}
function deepFreeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(deepFreeze);Object.freeze(value);}return value;}
export async function record(prefix, data) { return deepFreeze({id:`${prefix}_${await hash(data)}`, ...structuredClone(data)}); }
export class DomainError extends Error { constructor(code,message,status=400,details={}) { super(message); this.code=code; this.status=status; this.details=details; } }
