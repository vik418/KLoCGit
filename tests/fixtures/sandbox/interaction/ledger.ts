const charged = new Set<string>();
let charges = 0;

export function charge(id: string): void {
  if (charged.has(id)) return;
  charged.add(id);
  charges++;
}

export function reset(): void {
  charged.clear();
  charges = 0;
}
export function count(): number {
  return charges;
}
