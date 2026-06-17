# AI Orchestra — Deployment & Setup Guide

This guide covers deploying AI Orchestra on a **client's own server** (self-hosted),
from zero to a running instance with one-click Git integration.

It has three parts:

1. [Deploy the stack](#1-deploy-the-stack) — Docker Compose, secrets, reverse proxy, first admin.
2. [Set up Git integration](#2-set-up-git-integration-github--gitlab) — the per-deployment GitHub App / GitLab OAuth (Option A).
3. [Reference](#3-reference) — env vars, volumes, upgrades, backups, troubleshooting, security.

---

## 0. Overview

```
                         ┌──────────────────────────────┐
   Browser  ──TLS──▶  Reverse proxy (nginx/Caddy/Traefik)
                         │   terminates HTTPS, forwards   │
                         │   X-Forwarded-Proto / -Host    │
                         └───────────────┬────────────────┘
                                         ▼  :3000
                              ┌────────────────────┐     ┌────────────┐
                              │   orchestra-core    │────▶│ PostgreSQL │
                              │ (Fastify + dashboard│     │  (Docker)  │
                              │  static + scheduler)│     └────────────┘
                              └─────────┬───────────┘
                                        ▼ outbound HTTPS
                            github.com / your GitLab  (OAuth + API)
```

- **One container** serves both the API (`/api/*`) and the built dashboard SPA.
- **Postgres** holds all state, including the encrypted deployment + per-project secrets.
- Outbound HTTPS to GitHub/GitLab is required for the Git integration; inbound HTTPS is
  required so the providers can redirect users back to the OAuth callback.

---

## 1. Deploy the stack

### 1.1 Prerequisites

On the deployment server:

- **Docker** + **Docker Compose v2** (`docker compose`, not the legacy `docker-compose`).
- A **public DNS name** pointing at the server (e.g. `orchestra.client.com`) and the
  ability to terminate TLS in front of it (nginx / Caddy / Traefik / a cloud LB).
- Outbound HTTPS allowed to `github.com` / your GitLab host.
- A **Claude** subscription or Anthropic **API key** for the agents (see §1.6).

> Local development instead of production? See the root `README.md` → *Quick start*.

### 1.2 Get the code

```bash
git clone https://github.com/prokopofffff/ai-orchestra.git
cd ai-orchestra
```

### 1.3 Generate secrets

Three secrets must be set and **kept stable** across restarts:

```bash
# Session signing key (JWT). Losing/rotating it logs everyone out.
openssl rand -base64 48        # → JWT_SECRET

# AES-256 key that encrypts every stored secret at rest (git tokens, OAuth
# tokens, the GitHub App private key). Rotating it makes existing ciphertext
# undecryptable — back it up.
openssl rand -base64 32        # → ORCHESTRA_SECRETS_KEY

# Postgres password.
openssl rand -base64 24        # → POSTGRES_PASSWORD
```

> ⚠️ **`ORCHESTRA_SECRETS_KEY` is the master key for all stored credentials.**
> Store it in your secrets manager and never lose it. In `NODE_ENV=production`
> orchestra-core refuses to boot without it.

### 1.4 Configure `.env`

```bash
cp .env.example .env
```

Edit `.env` and set at minimum:

```bash
# Required
JWT_SECRET=<from openssl rand -base64 48>
ORCHESTRA_SECRETS_KEY=<from openssl rand -base64 32>
POSTGRES_PASSWORD=<from openssl rand -base64 24>

# Public origin of THIS deployment, no trailing slash. Required for OAuth
# redirects to resolve correctly behind a proxy.
ORCHESTRA_PUBLIC_URL=https://orchestra.client.com

# Claude auth (see §1.6)
CLAUDE_AUTH=max                # or: api  (+ CLAUDE_API_KEY=sk-ant-...)
```

The Git provider (GitHub App / GitLab OAuth) is configured **in-app after first boot**
(see §2) — you do **not** need to put any GitHub/GitLab secrets in `.env`.

The Docker Compose file reads these from `.env` automatically and **fails fast** if
`JWT_SECRET` or `ORCHESTRA_SECRETS_KEY` is missing.

### 1.5 Reverse proxy + TLS

orchestra-core listens on `:3000` (plain HTTP). Put a TLS-terminating proxy in front and
forward the standard headers — orchestra derives the OAuth callback origin from
`ORCHESTRA_PUBLIC_URL`, falling back to `X-Forwarded-Proto` / `X-Forwarded-Host`.

**Caddy** (`Caddyfile`):

```
orchestra.client.com {
    reverse_proxy 127.0.0.1:3000
}
```

**nginx**:

```nginx
server {
    listen 443 ssl http2;
    server_name orchestra.client.com;

    # ssl_certificate / ssl_certificate_key ...

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host  $host;
        proxy_set_header X-Real-IP         $remote_addr;
    }
}
```

> The OAuth callback URLs MUST be reachable over **HTTPS** at `ORCHESTRA_PUBLIC_URL`.
> GitHub/GitLab will redirect users there after they authorize.

### 1.6 Claude / Codex authentication

Agents run on Claude (and optionally Codex). Two modes:

- **Subscription (`CLAUDE_AUTH=max`)** — mount the operator's `~/.claude` credentials.
  The Compose file already mounts `${HOME}/.claude:/root/.claude:ro`. Run
  `claude login` on the host as the user that launches Compose so the directory exists.
  Per-project Claude/Codex logins can also be done from the dashboard (Settings →
  Claude/Codex → Authorize) and persist in the `orchestra_creds` volume.
- **API key (`CLAUDE_AUTH=api`)** — set `CLAUDE_API_KEY=sk-ant-...` in `.env`.

### 1.7 Launch

```bash
docker compose up -d --build
```

This builds the image (multi-stage: builds `shared`, `dashboard`, `mcp-tools`,
`orchestra-core`), starts Postgres, waits for it to be healthy, runs all DB migrations
automatically on boot, and starts orchestra-core.

Check it:

```bash
docker compose ps
curl -fsS https://orchestra.client.com/api/health   # → {"status":"ok",...}
docker compose logs -f orchestra-core
```

### 1.8 Create the instance admin

Open `https://orchestra.client.com` and **register the first account**.

> The **first registered user is the instance admin** (earliest `created_at`). This is
> the only account that can configure the deployment-wide Git integration in §2.
> Register it yourself before handing the URL to the team.

---

## 2. Set up Git integration (GitHub / GitLab)

**Model:** each deployment registers its **own** GitHub App / GitLab OAuth application —
nothing is shared with the vendor, and no provider secrets live in `.env`. The instance
admin does this once, in-app; credentials are stored **encrypted in the database**.

Sign in as the **instance admin**, then go to **Profile → «Интеграция Git»**.

If the panel warns that `ORCHESTRA_PUBLIC_URL` is unset, fix §1.4 first — OAuth redirects
will otherwise point at the wrong host.

### 2.1 GitHub (App Manifest flow — ~2 clicks)

1. (Optional) Type the **organization** to own the App; leave blank to create it on your
   personal account.
2. Click **«Create GitHub App»**. Your browser is redirected to GitHub with a pre-filled
   manifest.
3. On GitHub, review and confirm. The manifest requests least-privilege repo access:
   - **Repository permissions:** Contents R/W, Pull requests R/W, Metadata R
   - **Events:** `pull_request`, `push`
   - **Request user authorization (OAuth) during installation:** enabled — so a single
     install also yields user attribution for PRs/commits.
   - **Callback / Setup / Webhook URLs** are pre-filled to this deployment (see below).
4. GitHub redirects back to `…/api/git/github/manifest-callback`; orchestra **converts the
   manifest code into the App's id, client secret, private key, and webhook secret and
   stores them encrypted automatically**. The panel flips to ✓ with the App slug.

The manifest pins these URLs (shown in the admin panel for reference):

| Purpose | URL |
|---|---|
| OAuth callback | `${ORCHESTRA_PUBLIC_URL}/api/git/github/callback` |
| Manifest callback | `${ORCHESTRA_PUBLIC_URL}/api/git/github/manifest-callback` |
| Webhook | `${ORCHESTRA_PUBLIC_URL}/api/git/webhook` |

> Prefer to register the App by hand? You can, then put the values in `.env`
> (`GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID`,
> `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET`).
> **DB config (the manifest flow) takes precedence over env.**

### 2.2 GitLab (one-time OAuth app)

GitLab has no manifest flow, so create the OAuth application manually:

1. In GitLab, go to **User/Group/Admin → Applications → New application**.
2. **Redirect URI:** `${ORCHESTRA_PUBLIC_URL}/api/git/gitlab/callback`
3. **Scopes:** `api`. Mark it **Confidential**.
4. Save, then copy the **Application ID** and **Secret**.
5. Back in orchestra (Profile → Интеграция Git → GitLab), paste **Application ID**,
   **Secret**, and the **GitLab base URL** (`https://gitlab.com` or your self-hosted
   origin). Click **Save**.

### 2.3 How users connect (after admin setup)

Each user, per project, in **Settings → Доступ к репозиторию**:

- **GitHub** → **«Connect repository»** installs the App on the chosen repo (clone/push/PR
  access) and **«Connect GitHub account»** authorizes their user (so PRs/commits are
  attributed to them, not a bot).
- **GitLab** → **«Connect GitLab»** — a single OAuth authorization grants both repo access
  and identity.

No tokens are ever pasted. Credentials are stored encrypted and resolved per operation in
this precedence: **App installation token → owner's user OAuth token → manual PAT**.

### 2.4 Manual PAT fallback (advanced / air-gapped)

For GitHub Enterprise or environments where the App/OAuth flow isn't available, the old
behavior remains under **Settings → Доступ к репозиторию → «Дополнительно»**: paste a
fine-grained PAT (Contents R/W, Pull requests R/W) or a GitLab project access token. Stored
encrypted, used only when no App/OAuth credential is present.

---

## 3. Reference

### 3.1 Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `JWT_SECRET` | ✅ | Signs session cookies. Min 16 chars; refuses to boot in prod if unset. |
| `ORCHESTRA_SECRETS_KEY` | ✅ | base64 32-byte AES key encrypting all stored secrets at rest. |
| `POSTGRES_PASSWORD` | ✅ | Postgres password (Compose). |
| `ORCHESTRA_PUBLIC_URL` | ✅ (behind proxy) | Public HTTPS origin; basis for OAuth redirect URIs. |
| `DATABASE_URL` | ✅ | Set by Compose to the internal Postgres DSN. |
| `CLAUDE_AUTH` | – | `max` (subscription) or `api`. Default `max`. |
| `CLAUDE_API_KEY` | if `api` | Anthropic API key. |
| `ORCHESTRA_WORKSPACES_ROOT` | – | Per-user project root (Compose: `/workspace`). |
| `GITHUB_APP_*` / `GITLAB_OAUTH_*` | – | Optional env fallback for §2; DB config wins. |
| `GITHUB_DEFAULT_ORG` / `GITHUB_DEFAULT_BRANCH` | – | Defaults for new projects. |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | – | Deprecated globals; Telegram is per-project now. |
| `MODEL_TECH_LEAD` … `MODEL_DEVOPS` | – | Per-role model overrides. |
| `LOG_LEVEL` | – | `debug` \| `info` \| `warn` \| `error`. |

Git integration config lives in the `system_config` table (secrets encrypted), managed via
the admin panel. The env vars above are only a fallback/bootstrap.

### 3.2 Persistent volumes (back these up)

| Volume | Mount | Contents |
|---|---|---|
| `postgres_data` | Postgres data dir | **All state**, including encrypted secrets. |
| `orchestra_creds` | `/root/orchestra-creds` | Per-project Claude/Codex logins. |
| `sessions_data` | `/app/data/sessions` | Agent session worktrees. |
| `workspace_data` | `/workspace` | Per-user project checkouts. |

`docker.sock` is mounted for the preview feature only and is reachable solely by
orchestra-core code (the image ships without a `docker` CLI, so agents can't use it).

**Backup essentials:** `postgres_data` **and** the `ORCHESTRA_SECRETS_KEY`. The DB without
the key cannot decrypt any stored credential.

```bash
# DB dump
docker compose exec -T postgres pg_dump -U orchestra orchestra > orchestra-$(date +%F).sql
```

### 3.3 Upgrades

```bash
git pull
docker compose up -d --build      # migrations run automatically on boot
docker compose logs -f orchestra-core
```

Migrations are idempotent and applied at startup. No manual DB step is needed.

### 3.4 Troubleshooting

| Symptom | Cause / fix |
|---|---|
| OAuth ends on `…/settings?git=error&git_detail=...` | Read the detail. Common: redirect URI mismatch — the App/OAuth app's callback must equal `${ORCHESTRA_PUBLIC_URL}/api/git/<provider>/callback`. |
| `…?git=error` "invalid or expired state" | The connect link is older than 10 min, or `JWT_SECRET` changed mid-flow. Click Connect again. |
| Connect buttons missing / "не настроен на сервере" | Git integration not configured. Admin completes §2. Non-admins can't see the setup panel. |
| Admin panel warns about `ORCHESTRA_PUBLIC_URL` | Set it in `.env` and `docker compose up -d` so redirects use the real host. |
| Manifest callback "not an instance admin" | The flow must be started by the earliest-registered user. |
| Boot fails: `ORCHESTRA_SECRETS_KEY is required` | Set it in `.env` (§1.3). |
| All stored tokens fail to decrypt after a redeploy | `ORCHESTRA_SECRETS_KEY` changed. Restore the original key. |
| Push from an agent fails ~1h into a long session | GitHub installation tokens live ~1h; re-spawn the task. (Known follow-up.) |

### 3.5 Security notes

- **No vendor in the loop.** Each deployment owns its GitHub App / GitLab OAuth app; all
  secrets stay on the client's server, encrypted at rest with `ORCHESTRA_SECRETS_KEY`.
- **Least privilege.** The GitHub App requests only Contents + Pull requests (R/W) and
  Metadata (R). Installation tokens are scoped to the repos the user selects and are minted
  on demand (~1h lifetime), not stored long-term.
- **CSRF-safe OAuth.** The `state` parameter is an HMAC-signed, 10-minute token bound to the
  user/project; the public callbacks validate it (and re-check admin for the manifest flow).
- **Tenant isolation.** Per-project credentials never fall back to a shared env token, and
  the dashboard only ever receives "is set" markers — never ciphertext or plaintext.
- **Rotate** `JWT_SECRET` to force re-login; rotating `ORCHESTRA_SECRETS_KEY` invalidates all
  stored credentials (users must reconnect) — do it only deliberately.
```
