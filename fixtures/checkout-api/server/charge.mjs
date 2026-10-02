/** Charge and confirmation are observable effects, rather than test assertions. */
export async function charge(state, {orderId, amountCents}, idempotencyKey, effectsUrl) {
  if (!orderId || !idempotencyKey || !Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw new Error('An order, idempotency key and positive integer amount are required');
  }
  const previous = state.receipts.get(idempotencyKey);
  if (previous) return previous;

  const charged = await fetch(`${effectsUrl}/charge`, {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({orderId, amountCents}), signal: AbortSignal.timeout(1000)
  });
  if (!charged.ok) throw new Error('Payment provider failed');
  const receipt = await charged.json();
  state.charges.push(receipt);
  const confirmation = {orderId, channel: 'email', receipt: receipt.chargeId};
  const confirmed = await fetch(`${effectsUrl}/confirmation`, {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify(confirmation), signal: AbortSignal.timeout(1000)
  });
  if (!confirmed.ok) throw new Error('Confirmation provider failed');
  state.confirmations.push(confirmation);
  state.receipts.set(idempotencyKey, receipt);
  return receipt;
}
