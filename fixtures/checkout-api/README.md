# Checkout application

Run `node app.mjs` to start the sample HTTP application. It prints a loopback port.

- `POST /checkout` sends a payment through the retry client.
- `POST /charge` records a charge and confirmation, deduplicating by idempotency key.
- `GET /state` exposes the sample ledger.

Payments and confirmations are simulated. A lost response does not undo a request already processed by the service. The separate payment-policy repository defines the contract used by the platform validator.
