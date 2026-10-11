# Contributing

Keep changes small and explain their purpose. Use clear names, explicit interfaces, and comments that explain why.

## Development

Use Node.js 24, Git, and Linux or WSL. Full verification also needs bubblewrap, util-linux, FUSE 3, and Chromium system libraries.

Compiler fixtures use Python 3.12.14, Go 1.26.9/1.27.2, and Rust 1.90.0. The [toolchain action](.github/actions/analysis-tools/action.yml) installs these versions in CI.

```sh
npm ci
npm test
npm run lint
npm run format
npm run verify
```

`verify` runs formatting, lint, tests, the UI build, Worker/executor dry runs, and browser checks. Install Chromium system libraries with `npx --no-install playwright install-deps chromium`.

ArtifactFS tests need the pinned binary. Build it with `node scripts/install-artifact-fs.mjs <install-directory> <go-binary>`, then set `KLOCGIT_ARTIFACT_FS_BINARY`. Compiler paths accept `KLOCGIT_GO_1_26_9`, `KLOCGIT_GO_1_27_2`, and `KLOCGIT_RUST_TOOLCHAIN`.

## Engineering rules

- Keep provider SDKs outside the domain.
- Bind evidence to exact code, configuration, and environment versions.
- Check the reviewed basis and use compare-and-swap for canonical Git updates.
- Treat model output as inference. Required incomplete analysis blocks resolution.
- Keep speculative candidate trees local. Never give untrusted execution canonical credentials.
- Version persisted records and events. Make irreversible operations idempotent.
- Keep queue payloads bounded and verify referenced payload digests.
- Test behavior and failure recovery. Avoid tests tied to the repository layout.
- Use the formatter. Python docstrings follow Google's `Args`, `Returns`, and `Raises` conventions.
- Never commit credentials or log secrets.

Include the problem, resulting behavior, and relevant validation in each pull request. Release claims require observed evidence.
