export function shortId(value) {
  return value?.replace(/^[a-z]+_/, '').slice(0, 8) ?? '—';
}
