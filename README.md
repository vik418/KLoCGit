# klocgit

klocgit v0 keeps possible changes in isolated Git repositories called Futures. Humans, agents and ordinary Git clients can work independently. The goal is to show which choices need your attention and preserve why you chose them.

Create repositories, open Futures, combine whole revisions or selected commits, and validate the exact result. A reviewed candidate can advance Git through guarded updates. Context and evidence explain each choice. Partial multi-repository updates have explicit recovery; Git history stays intact.

## Run locally

Use Node.js 24 and Git:

```sh
git clone https://github.com/vik418/klocgit.git
cd klocgit
npm ci
LOCAL_ACTOR_ID="$(git config user.email)" npm run dev
```

Open <http://localhost:43187>. The server starts with an empty workspace. Create or import a repository, then choose **Fork repository** to create a Future from its current commit. The interface shows its Git remote and observed revisions.

Use **Repositories → Browse code** to inspect directories, files, raw text and first-parent commit history. Branch/tag selection and file permalinks bind reads to an exact commit. Binary files and submodules are identified; signatures remain unverified unless a verifier establishes their validity.

The command uses your configured Git email as the local identity. `PORT` changes the port. This local identity is not organizational authentication.

The sample application is optional. Stop the server, run `npm run demo:reset`, then start it again. This replaces the default disposable `.klocgit-workspace/` directory with the two-repository demo. Executable demo checks require Linux or WSL with bubblewrap and util-linux.

## Develop

```sh
npm run verify
```

Verification requires Linux or WSL, Node.js 24, Git, bubblewrap, util-linux, FUSE 3 and Chromium system libraries. Compiler fixtures use Python 3.12.14, Go 1.26.9/1.27.2 and Rust 1.90.0. CI installs these versions with the [analysis toolchain action](.github/actions/analysis-tools/action.yml). Local compiler paths can be configured with `KLOCGIT_GO_1_26_9`, `KLOCGIT_GO_1_27_2` and `KLOCGIT_RUST_TOOLCHAIN`.

Build the pinned ArtifactFS tool with `node scripts/install-artifact-fs.mjs <absolute-install-directory> <absolute-go-binary>` and set `KLOCGIT_ARTIFACT_FS_BINARY` to its executable. On a new host, install Chromium system libraries with Playwright's `install-deps chromium` command. Verification installs locked npm dependencies and Chromium, then runs all local checks, including browser smoke tests.

The v1 implementation follows [CODEX.md](CODEX.md), the frozen [architecture](ARCHITECTURE.md), the ordered [backlog](TASKS.md), [validation gates](VALIDATION.md) and [implementation decisions](DECISIONS.md). Existing v0 features do not establish v1 completion.

The [v0 design document](docs/design.md) contains the system diagram, core contracts and safety boundaries. The authenticated capability registry distinguishes verified local behavior from partial, experimental and unsupported workflows.

Cloudflare runs the API Worker, Durable Object, Artifacts repositories, Queue and private Git executor. The UI is React; the control plane is JavaScript. Analysis uses the TypeScript compiler and Python, Go and Rust helpers. Each analyzer publishes its capability limits. Cloudflare integration remains experimental until the complete live path is verified.

Automatic push delivery requires `CLOUDFLARE_ACCOUNT_ID` and `ARTIFACTS_EVENTS_QUEUE_ID`
on the API Worker, plus the `ARTIFACTS_SUBSCRIPTION_TOKEN` secret: an account-scoped
Cloudflare API token permitted to manage event subscriptions. Keep these credentials
out of Git. New isolated repositories receive their own confirmed push subscription.

To combine work, open **Futures → Compose candidate**. Select whole Futures or ordered commit hashes. Review the resulting tree, run trusted validation and record why you chose it. Applying a candidate updates Git only when the reviewed state is still current. Multi-repository updates proceed in recorded stages. A partial update requires reconciliation and a fresh review before continuation.
