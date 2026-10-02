# Real checkout interaction fixture

`checkout-api/` is a runnable Node HTTP application. `payment-policy/` is a second
ordinary Git repository containing the existing exactly-once effects contract and
the prior confirmation decision. Copy them into repositories using the helpers in
`application.mjs`; helpers alter executable source files and supply no decision
group identifiers.

The semantic interaction uses two disjoint files:

| Candidate | Real HTTP attempts after a lost processed response | Trusted provider charges | Trusted provider confirmations | Check |
| --- | ---: | ---: | ---: | --- |
| Baseline | 1 | 1 | 1 | Pass |
| A: retry using the same order key | 2 | 1 | 1 | Pass |
| B: send confirmation before deduplication | 1 | 1 | 1 | Pass |
| A+B: ordinary clean Git composition | 2 | 1 | 2 | Fail |

The platform-owned supervisor runs a payment/confirmation HTTP provider outside
the candidate process. It counts the actual effects received by that provider.
A separate platform proxy discards the first payment response only after the
payment handler and its external effects finish. Candidate `/state`, stdout,
metadata, and producer-supplied tests cannot supply the effect counts.

The baseline deliberately has no recovery from a lost response: the checkout
endpoint returns 502, while its processed charge and confirmation remain. The
contract under test is exactly one effect after a processed response is lost,
rather than guaranteed checkout success. Adding A recovers the response without
adding effects. Adding B alone still sends one confirmation. Together, A and B
send two confirmations even though payment deduplication keeps one charge.

## Runner interface

```js
import {createApplicationRunner} from '../server/runner.mjs';
const runner = await createApplicationRunner({
  repositoryPath: '/path/to/checkout-api.git',
  policyRepositoryPath: '/path/to/payment-policy.git',
  policyCommit: '<full immutable policy commit>'
});
const evidence = await runner.validate('<full immutable candidate commit>');
```

The result includes `passed`, bounded `checks`, `observations`, `tree_hash`,
`config_hash`, the pinned `policy` commit and tree, and the platform-owned suite
footprint. `applicationValidationConfigHash()` provides the runner configuration
hash without creating a runner. `materializeGitTree()` extracts only immutable
ordinary blobs; it rejects symlinks, submodules, unsafe paths and oversized trees.

Linux, Node 22 or later, Git, bubblewrap and util-linux `prlimit` are required.
The executor must permit private user, PID and network namespaces. Validation
fails closed as `validation-unavailable` when this isolation cannot start. There
is no unsandboxed fallback.

Candidate execution sees a read-only materialized tree and runtime, a scrubbed
environment, and a private loopback-only network. Node's permissions disable
filesystem access outside the tree, subprocesses, native addons and workers.
Outer CPU, address-space, descriptor, output and wall-time limits bound execution.
The candidate may access the trusted effect provider only through HTTP. The
trusted supervisor captures candidate output separately from its result channel.

`node --test tests/application.test.mjs` verifies the semantic interaction,
untrusted ledger/test claims, environment/filesystem/network isolation, and safe
rejection of symlink entries. These are finite scenarios using simulated payment
and email effects. They establish neither global semantic correctness nor a
complete hostile-code isolation audit.
