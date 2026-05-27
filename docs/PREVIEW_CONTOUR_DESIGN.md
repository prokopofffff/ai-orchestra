# Preview contour — design

Tech-lead (agent and human) needs a running instance of the project's
docker image, reachable by URL, to verify a change end-to-end. Today
there is no such thing: QA does code-level validation only, and
spinning up the project requires host docker access — which we
revoked for multi-tenancy reasons (see [MULTI_TENANT_ROADMAP.md](MULTI_TENANT_ROADMAP.md)).

This doc describes the design for a long-lived, per-project preview
environment that an agent can drive via MCP and a human can open in
the browser, without re-opening the docker.sock leak.

## Goals

- TL-agent: one MCP call → URL that responds to `curl`.
- Human: dashboard widget → button → working app in browser.
- One preview per project, reachable via a stable URL.
- Idle preview sleeps automatically, wakes on first request.
- Cross-tenant access is impossible by construction (network +
  filesystem isolation), not just by app-level checks.
- Push to the configured branch auto-redeploys.

## Non-goals (for v1)

- Multiple parallel previews per project (one per feature branch).
  Future work — would need URL routing on branch name and quota.
- Stateful databases inside the preview. v1 supports stateless apps
  (binds an external DSN via env). Compose with a DB sidecar is v3.
- Per-PR ephemeral previews. v1 is per-project, branch-pinned.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│ host (vlad-1)                                                    │
│                                                                  │
│  ┌──────────────────────────┐  per-project docker network       │
│  │ orchestra-core           │ ──TCP+TLS──> ┌──────────────────┐ │
│  │                          │  :2376       │ preview-dind-A   │ │
│  │  - preview-manager       │              │ (docker:dind)    │ │
│  │  - dockerode (TLS client)│              │   └─ app-A:PORT  │ │
│  │  - @fastify/http-proxy   │              └──────────────────┘ │
│  │  - JWT authn             │                                    │
│  │                          │ ──TCP+TLS──> ┌──────────────────┐ │
│  │                          │  :2376       │ preview-dind-B   │ │
│  │                          │              │   └─ app-B:PORT  │ │
│  └──────────┬───────────────┘              └──────────────────┘ │
│             │ :443 (existing publish)                           │
└─────────────┼───────────────────────────────────────────────────┘
              │
   https://preview-<projectId>.orchestra.example.com
              │
   [Browser]   [TL-agent → http://preview-<id>.internal:PORT via curl]
```

Each project gets its own DinD sidecar on its own user-defined docker
network. orchestra-core talks to it over `tcp://...:2376` with a
per-project client cert. The app container runs inside the DinD and
is reachable from orchestra-core (which is on the same network) but
not from any other project's DinD.

### Isolation properties

| Attack | Defence |
|---|---|
| Project A's image escapes to its DinD | DinD only mounts project A's worktree; no other tenant's files visible |
| Project A's DinD reaches project B's DinD | Separate docker networks, no inter-network route |
| External attacker hits `preview-A.orchestra.example.com` | Reverse-proxy requires JWT cookie + `userCanAccessProject` |
| User from tenant B knows project A's UUID | `userCanAccessProject(B, A)` = false → 403 |
| Operator pwn | Out of scope (host root). |

The privileged `docker:dind` container is still privileged; the threat
model is **cross-tenant leak**, not kernel-escape. For kernel-escape
threats see roadmap item #3 (external CI). This design accepts the
"single privileged sidecar per tenant" trade-off for the convenience
of in-house previews.

## Data model

New table `preview_envs` (one row per project):

```sql
CREATE TABLE preview_envs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          uuid NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  enabled             boolean NOT NULL DEFAULT false,

  -- build inputs (one of dockerfile_path / compose_file_path required when enabled)
  dockerfile_path     text,
  compose_file_path   text,
  branch              text NOT NULL DEFAULT 'main',
  app_port            integer NOT NULL,

  -- encrypted JSON: { ENV_NAME: ciphertext }
  env_vars_encrypted  text,

  -- lifecycle config
  idle_timeout_minutes integer NOT NULL DEFAULT 120,
  auto_redeploy_on_push boolean NOT NULL DEFAULT true,

  -- runtime state (maintained by preview-manager)
  state               text NOT NULL DEFAULT 'stopped',
                      -- stopped | building | running | sleeping | error
  current_commit      text,
  last_request_at     timestamptz,
  last_deployed_at    timestamptz,
  error_message       text,

  -- DinD client TLS, encrypted at rest
  dind_ca_encrypted   text,
  dind_cert_encrypted text,
  dind_key_encrypted  text,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX preview_envs_state_idx ON preview_envs (state)
  WHERE state IN ('running', 'sleeping');
```

`env_vars_encrypted` reuses `encryptSecret`/`decryptSecret` from
`secrets.ts`. Per-tenant KMS (roadmap #4) drops in transparently.

### Container naming

| Resource | Name |
|---|---|
| Docker network | `preview-net-<projectId>` |
| DinD sidecar | `preview-dind-<projectId>` |
| App container (inside DinD) | `preview-app` (unique within its DinD) |
| Public hostname | `preview-<projectId>.orchestra.example.com` |
| Internal hostname (agent-side) | `preview-<projectId>.internal` |

## HTTP API

All routes gated on `userCanEditProject` unless noted.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/projects/:id/preview` | Read config + state (gate: `userCanAccessProject`) |
| PUT | `/api/projects/:id/preview` | Upsert config (enable, dockerfile, branch, port, env, idle) |
| POST | `/api/projects/:id/preview/deploy` | Force redeploy (pull → build → run) |
| POST | `/api/projects/:id/preview/stop` | Stop app container (DinD stays) |
| POST | `/api/projects/:id/preview/teardown` | Stop DinD, delete network |
| GET | `/api/projects/:id/preview/logs?tail=200` | App container logs |
| POST | `/api/projects/:id/preview/wake` | Internal — called by reverse-proxy on first request |

Request/response bodies validated with zod; `env_vars` values
encrypted server-side before persisting.

## Reverse proxy

Fastify route registered in orchestra-core, matches `Host:` header
`preview-<uuid>.<configured-base>`:

1. Parse `projectId` from host.
2. Verify JWT cookie → `userId`. No cookie → 302 to dashboard login
   with return URL.
3. `userCanAccessProject(userId, projectId)` → 403 otherwise.
4. Load `preview_envs` row. If `enabled=false` → 404. If
   `state='error'` → 502 with `error_message`. If `state='sleeping'`
   → call `wake(projectId)`, return interstitial HTML with
   `<meta http-equiv="refresh" content="3">` until `state='running'`.
5. Update `last_request_at` (throttled, 30s window — same pattern
   as agent heartbeat).
6. Proxy via `@fastify/http-proxy` to
   `http://preview-app.<dind-network>:<port>`.

WebSockets: `@fastify/http-proxy` supports `ws:true`. Enable.

## MCP tool surface

New MCP tool `preview` exposed to tech-lead role only (added to
`role-definitions.ts` allowlist):

```ts
preview_status({ projectId }) → {
  state, url, internalUrl, currentCommit, lastDeployedAt, errorMessage
}

preview_deploy({ projectId, branch? }) → {
  url, internalUrl, state, currentCommit
}
// Blocks until state=running or error. Internal URL is what the
// agent should curl (reachable inside orchestra-core's network).

preview_logs({ projectId, tail? }) → {
  lines: string[]
}
```

The agent gets `internalUrl` (`http://preview-<id>.internal:PORT`),
not the public one — it doesn't have a JWT and shouldn't need one,
since orchestra-core's network is the trust boundary.

## preview-manager (orchestra-core/src/preview-manager.ts)

Single-process reconciler (mirrors `telegram-manager` shape):

- `reconcile()` — cron, every 60s:
  - For each `enabled=true` preview_env:
    - If DinD container missing → start it (and create network, generate
      TLS certs if absent).
    - If `state='running'` and `last_request_at < now() - idle_timeout`
      → stop app container, set `state='sleeping'`.
    - If `state='error'` and `updated_at < now() - 5min` → retry
      deploy (backoff).
- `deploy(projectId, branch?)`:
  - Acquire per-project advisory lock (`pg_try_advisory_lock`).
  - In worktree: fetch + checkout branch + record `current_commit`.
  - `tar` worktree → stream into DinD `docker build -`.
  - `docker stop preview-app` (if exists), `docker rm`, then
    `docker run -d --name preview-app -p <port>:<port>
        -e ENV_VARS_FROM_CONFIG <image>`.
  - Wait for HTTP 200 on `http://app:port/` (configurable health
    path later) with 60s timeout.
  - Update `state`, `current_commit`, `last_deployed_at`.
- `wake(projectId)`:
  - If `state='sleeping'`, `docker start preview-app`, wait health.
  - Returns when running or after 30s timeout (proxy interstitial
    will keep polling).
- `stop(projectId)`, `teardown(projectId)` — straightforward.

All docker calls use `dockerode` against the per-project DinD via TCP
+ TLS, never the host socket.

### TLS cert provisioning

On first DinD start, generate inside orchestra-core:
- CA cert + key
- Server cert (CN: DinD container name)
- Client cert (CN: `orchestra-core`)

Persist `dind_ca_encrypted`, `dind_cert_encrypted`, `dind_key_encrypted`
via `encryptSecret`. Server cert/key get mounted into DinD via a
named volume on first start; subsequent restarts reuse them.

Use `node-forge` (already in lockfile? check) or `selfsigned` package
— ~50 LoC.

## Auto-redeploy on push

`pr-watcher` already polls the configured branch. Extend the existing
loop: when `branch` of a `preview_envs` row sees a new commit on the
remote, enqueue `preview_deploy(projectId, branch)`. No new poller.

User opt-out via `auto_redeploy_on_push=false`.

## Idle shutdown UX

| State | Dashboard pill | Browser open behaviour |
|---|---|---|
| `running` | green "running" | proxy → app, instant |
| `sleeping` | grey "sleeping" | interstitial "starting…", wakes in 5-15s |
| `building` | yellow "building" | interstitial "building…", polls |
| `error` | red, click for message | 502 with message |
| `stopped` | grey "stopped" | 404, user clicks **Deploy** in dashboard |

Resource floor: idle DinD ≈ 200 MB RAM each. For >10 projects we'll
also sleep the DinD itself (additional 5-10s wake latency). v1 keeps
DinD warm; v2 adds DinD-level sleep gated on a higher inactivity
threshold (e.g. 24h).

## Settings UI

New section in `dashboard/src/routes/Settings.tsx`, gated on
`userCanEditProject`:

```
☑ Enable preview environment

  ○ Dockerfile     [backend/Dockerfile        ]
  ○ docker-compose [                         ]  ← v3, hidden in v1

  Branch to deploy   [main                    ]
  App port           [8443                    ]
  Idle shutdown      [120] minutes
  ☑ Auto-redeploy on push to branch

  Environment variables:
    DATABASE_URL  [********] (encrypted)  [edit] [remove]
    API_KEY       [********]               [edit] [remove]
    [+ Add variable]

  Preview URL: https://preview-abc123.orchestra.example.com  [copy]
  Status: ● running   commit 8506cd0   deployed 14m ago

  [Redeploy]  [Stop]  [Logs]  [Teardown]
```

## Security checklist

- [ ] All `/api/projects/:id/preview*` routes gated on
      `userCanAccessProject` (read) / `userCanEditProject` (write).
- [ ] Reverse proxy: JWT required, `userCanAccessProject` enforced.
- [ ] `env_vars` encrypted at rest via `encryptSecret`.
- [ ] DinD TLS certs encrypted at rest.
- [ ] No project ever sees another project's docker network
      (verified by `docker network inspect` in deploy smoke test).
- [ ] No project's DinD can connect to host docker socket (it isn't
      bound). Smoke: from inside DinD, `docker info` only shows its
      own daemon.
- [ ] Audit log: deploy / stop / teardown / wake events written to
      `flow_audit`.
- [ ] Rate-limit `/preview/deploy` per project (1 in flight, queued).

## Rollout phases

### v1 — MVP (this PR cluster, ~3-4 days)

- `preview_envs` table + migration.
- preview-manager with `reconcile`, `deploy`, `stop`, `wake`,
  TLS-cert provisioning.
- HTTP API: GET/PUT/deploy/stop/logs/wake.
- Reverse proxy on orchestra-core, JWT + access gate.
- MCP tool `preview_status` / `preview_deploy` / `preview_logs`,
  tech-lead allowlist only.
- Settings UI section, Dockerfile-only.
- Idle app-container sleep at configured timeout.
- Audit log entries.

### v2 — Robustness (~2 days)

- DinD-level sleep on long inactivity, wake with progress UI.
- Auto-redeploy on push (hook into pr-watcher).
- Per-project log retention (rotate beyond N MB).
- Deploy backoff on repeated failures.

### v3 — Compose support (~2 days)

- `compose_file_path` populates a stack with possibly multiple
  services. Reverse proxy still binds to a single named entry
  (configured `app_service`).
- Health check configurable per service.

### v4 — Per-branch ephemeral previews (deferred)

- `preview_envs` becomes per-(project, branch). PR open → preview up,
  PR closed → teardown. Needs quota + cleanup.

## Open questions

1. **DNS / TLS for `preview-*.orchestra.example.com`.** Production
   needs wildcard cert + wildcard DNS pointing at vlad-1. Workable
   via Let's Encrypt DNS-01 (Cloudflare) or a wildcard from the
   existing domain. Decision needed before v1 ships.
2. **Where to store generated images.** `docker:dind` keeps them
   inside the DinD's own storage driver. Disk cost: a node app
   image ≈ 200 MB. For 10 projects with rebuilds ≈ a few GB.
   Acceptable; need a janitor to prune old image layers monthly.
3. **What about projects without a Dockerfile?** v1: feature disabled
   for them, UI shows "Add a Dockerfile to enable previews". Not
   trying to auto-detect-and-buildpack.
4. **Cost tracking?** Preview RAM/CPU is real cost. Out of scope
   for v1; revisit when we have >1 customer.
