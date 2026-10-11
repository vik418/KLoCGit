# KLoCGit

KLoCGit helps people and agents work on software at the same time. It combines their changes, checks the result, and shows the choices that need human judgment.

Git stores the code. KLoCGit records the evidence and reasons behind each accepted change.

## System design (HLD)

```mermaid
flowchart LR
    Users[People and agents] --> API[Workers API]
    Users --> Git[Artifacts Git repositories]
    Git -->|Push events| Queue[Analysis queue]
    Queue --> Executor[Isolated executor]
    API --> Coordinator[Durable Object coordinator]
    Executor -->|Candidates and evidence| Coordinator
    Coordinator -->|Decisions| Users
    Coordinator -->|Reviewed Git update| Git
    Coordinator -->|Accepted state| CD[External deployment tools]
    CD -->|Observed status| API
```

## Convergence design (LLD)

```mermaid
flowchart TD
    Revision[Exact Git revisions and effects] --> Reduce[Reduce duplicate and superseded work]
    Reduce --> Spec[Candidate composition plan]
    Spec --> Materialize[Compose locally in the executor]
    Materialize --> Evidence[Evaluate the exact candidate state]
    Evidence --> Decision[Decision with evidence and policy basis]
    Decision --> Review[Human resolution]
    Review --> Check{Basis and Git head still current?}
    Check -->|Yes| CAS[Compare-and-swap Git update]
    Check -->|No| Stale[Refresh and review again]
    CAS --> Accepted[Record accepted state and audit]
```

Candidate trees stay local until promotion. Incomplete required analysis blocks resolution. Deployment tools own rollout and recovery.

## Run locally

Use Node.js 24 and Git.

```sh
git clone https://github.com/vik418/KLoCGit.git
cd KLoCGit
npm ci
LOCAL_ACTOR_ID="$(git config user.email)" npm run dev
```

Open <http://localhost:43187>. Create or import a repository, fork work, and browse its files. The Git email identifies local requests; production requires authenticated identities.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and checks.
