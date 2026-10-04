# KLoCGit

KLoCGit groups concurrent Git changes into decisions. Review alternatives and their evidence, then apply a selected composition against the exact Git head and decision basis you reviewed. Git remains the source of truth for code.

The application includes native merge requests, revision-bound reviews, candidate validation, a merge queue and reviewed reverts. It is under development; see [architecture](docs/architecture.md) for the current boundaries.

## Start locally

Install Node.js 24 and Git, then:

```sh
git clone https://github.com/vik418/KLoCGit.git
cd KLoCGit
npm ci
npm run dev
```

Open <http://localhost:43187>. To change the port, use `PORT=43188 npm run dev`.

The local workspace lives in `.demo-v2/`. It contains two sample Git repositories and a question about retrying a lost payment response. Answer the question and start the sample producers to explore the review flow. **Work** also provides merge requests and ordinary proposal review.

Application validation requires Linux, bubblewrap, util-linux and permission to create private user and network namespaces. The interface can start without those facilities, but executable candidates cannot pass validation. Windows users should use WSL; see [development](docs/development.md) for setup and troubleshooting.

## Work on the project

```sh
npm run check
```

This runs formatting, lint, tests, browser build and Worker dry runs. The full test suite needs the Linux sandbox described above. Dry runs check bundling and do not deploy resources.

- [Development and tests](docs/development.md)
- [Design and guarantees](docs/architecture.md)
- [Merge requests, queues and reverts](docs/workflows.md)
- [Cloudflare deployment](docs/cloudflare.md)
- [Contribution guidelines](CONTRIBUTING.md) and [security policy](SECURITY.md)

To inspect the sample application's resulting code, clone its ordinary repository:

```sh
git clone .demo-v2/repositories/checkout-api.git checkout-result
cd checkout-result
node app.mjs
```

The sample uses simulated payment and confirmation effects. Its [fixture documentation](fixtures/README.md) explains the interaction being tested.
