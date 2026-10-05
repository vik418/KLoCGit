# KLoCGit

Pronounced **“clock it.”**

When several people or tools change the same project, KLoCGit brings related work together. You compare the choices, see the checks, and decide what to keep. Git stores the code. KLoCGit records the reasons and decisions.

## Run locally

Install Node.js 24 and Git:

```sh
git clone https://github.com/vik418/KLoCGit.git
cd KLoCGit
npm ci
npm run dev
```

Open <http://localhost:43187>. Use `PORT=43188 npm run dev` to change the port.

The demo has two sample repositories. Answer the setup question, then start the sample producers. Code validation needs Linux or WSL with bubblewrap and util-linux. See [local setup](docs/design.md#local-development).

## How it runs

- **React UI:** shows work, choices, and checks.
- **Worker backend:** handles the API, records work, and coordinates decisions through a Durable Object.
- **Private Git executor:** runs Git and trusted checks in a Container.

JavaScript runs both the backend and UI. The local server uses the same engine as the Cloudflare deployment.

Cloudflare runs the API as `klocgit` and the Git executor as `klocgit-git-executor`. Both use this repository’s `main` branch.

## Develop

```sh
npm run check
```

The [design document](docs/design.md) contains the system diagram, contracts, workflows, runtime boundaries, security, and coding standards. The project is under development; its supported workflows and limits are listed there.
