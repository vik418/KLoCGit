export function createState() {
  return { receipts: new Map(), charges: [], confirmations: [] };
}

export function snapshot(state) {
  return { charges: [...state.charges], confirmations: [...state.confirmations] };
}
