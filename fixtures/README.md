# Sample repositories and validation

`checkout-api/` is a small payment HTTP application. `payment-policy/` is a separate repository containing its effect contract and a recorded confirmation decision. `application.mjs` copies these fixtures and applies sample producer changes. `trusted/supervisor.mjs` belongs to the platform runner and is not taken from candidate code.

The example demonstrates a composition bug: retrying a lost processed response and sending confirmation before replay detection work individually, but combining them sends a duplicate confirmation. Their source files merge cleanly. The supervisor observes HTTP effects received by an external simulated provider and suppresses a response only after processing; candidate logs and its own ledger cannot supply those observations.

All payment and confirmation effects are simulated. The checks cover the configured cases, not all application behavior.

## Runner

```js
import { createApplicationRunner } from '../server/runner.mjs';

const runner = await createApplicationRunner({
  repositoryPath: '/path/to/checkout-api.git',
  policyRepositoryPath: '/path/to/payment-policy.git',
  policyCommit: '<full policy commit>',
});
const result = await runner.validate('<full candidate commit>');
```

Results include the exact tree, configuration and policy hashes, check outcomes and bounded observations. `applicationValidationConfigHash()` computes the expected configuration hash from the runner/supervisor source and limits.

Use Linux, Node.js 24, Git, bubblewrap and util-linux with private namespace support. The runner extracts ordinary immutable blobs and rejects symlinks, submodules, unsafe paths and oversized trees. Execution uses a read-only tree/runtime, private network, scrubbed environment, Node permissions and resource limits. Unavailable isolation returns `validation-unavailable`; there is no direct execution fallback.

Run `node --test tests/application.test.mjs` for application interaction and isolation regressions. See [development](../docs/development.md) for host setup and [architecture](../docs/architecture.md) for evidence eligibility.
