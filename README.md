# KLoCGit

KLoCGit helps people and agents work on software at the same time. It combines their changes, checks the result, and shows the choices that need human judgment.

Git stores the code. KLoCGit records the evidence and reasons behind each accepted change.

## System design (HLD)

![System design (HLD)](docs/diagrams/system-design.png)

<details>
<summary>Mermaid source</summary>

```mermaid
flowchart TB
    Client["Humans, agents, Git clients"]
    Git["Artifacts<br/>Code and refs"]
    API["Worker API<br/>Authentication and ingress"]
    State["Durable Object<br/>Decisions and operation journal"]
    Executor["Git executor<br/>Local composition and checks"]
    Evidence["Evidence storage<br/>Payloads and retention"]
    CD["External CD<br/>Rollout and recovery"]
    Client -->|Git| Git
    Client -->|Tasks and review| API
    Git -->|Push events| API
    API --> State
    State -->|Queued analysis| Executor
    Executor -->|Exact-state evidence| State
    State -->|Authorized promotion| Executor
    Executor -->|Ref CAS| Git
    Executor --> Evidence
    State -->|Accepted state| CD
```

</details>

<details>
<summary>Promotion sequence (LLD)</summary>

![Promotion sequence (LLD)](docs/diagrams/convergence-design.png)

```mermaid
sequenceDiagram
    actor Client
    participant P as PromotionService
    participant S as CoordinationStore
    participant G as GitStore
    Client->>P: Decision, reviewed basis, expected OID
    P->>S: Check resolved Decision, current basis and policy
    S-->>P: Authorized exact Candidate
    P->>S: Persist PREPARED operation
    P->>G: CAS(expected OID, target commit)
    alt Ref updated
        G-->>P: Confirmed success
        P->>S: Record APPLIED, SystemRevision and audit
        P-->>Client: Accepted
    else Ref changed
        G-->>P: CAS rejected
        P-->>Client: Refresh and review
    else Reply lost or executor crashed
        P->>G: Observe authoritative ref
        P->>S: Reconcile PREPARED journal
    end
```

</details>

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
