# klocgit

klocgit v0 keeps possible changes in isolated Git repositories called Futures. Humans, agents and ordinary Git clients can work independently. The goal is to show which choices need your attention and preserve why you chose them.

This delivery adds repository creation, public import and Future observation. The existing review kernel provides checked compositions and guarded Git updates. Native partial composition and promotion are still to be built.

## Run locally

Use Node.js 24 and Git:

```sh
git clone https://github.com/vik418/klocgit.git
cd klocgit
npm ci
LOCAL_ACTOR_ID="$(git config user.email)" npm run dev
```

Open <http://localhost:43187>. The server starts with an empty workspace. Create or import a repository, then create a Future from a repository with a commit. The interface shows its Git remote and observed revisions.

The command uses your configured Git email as the local identity. `PORT` changes the port. This local identity is not organizational authentication.

The sample application is optional. Stop the server, run `npm run demo:reset`, then start it again. This replaces the default disposable `.klocgit-workspace/` directory with the two-repository demo. Executable demo checks require Linux or WSL with bubblewrap and util-linux.

## Develop

```sh
npm run check
```

The [design document](docs/design.md) contains the system diagram, contracts, setup, safety rules and remaining work. The authenticated capability registry distinguishes verified local behavior from partial, experimental and unsupported workflows.

Cloudflare runs the API Worker, Durable Object, Artifacts repositories, Queue and private Git executor. The UI is React; the backend is JavaScript. Cloudflare integration remains experimental until the complete live path is verified.
