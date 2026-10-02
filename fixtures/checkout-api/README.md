# Checkout application

Run `node app.mjs` to start the HTTP application on a loopback port printed to stdout.
`POST /checkout` creates a payment through the client retry module. `POST /charge`
records a charge and an email confirmation, deduplicating by idempotency key.
`GET /state` exposes the demonstration ledger. No real money or email is involved.

The ordinary client makes one attempt. An unavailable response does not undo a
payment that the service has already processed. The policy lives in the separate
payment-policy Git repository; producer scripts are not trusted validation.
