# AGENTS.md

These are instructions for AI coding agents (Claude Code, GitHub Copilot, Codex, Cursor, Gemini
and others) and for the people who use them. Human contributors should read
[CONTRIBUTING.md](CONTRIBUTING.md) first. Everything here applies to humans as well.

## Project

byoghapp ("Bring Your Own GitHub App") is an open registry of GitHub App definitions that users
create and own themselves. Each vendor that asks customers to register their own GitHub App gets
one JSON entry. A static site renders each entry with a permission risk summary and launchers
that open GitHub's pre-filled "new app" form.

**Status: pre-MVP.** The repository scaffolding exists. The schema, data, validator and site do
not exist yet. Don't assume a file exists because it's listed below. Check first.

## Non-negotiable design rules

1. **Zero dependencies.** No npm packages at runtime or build time. Use the web platform and
   Node.js built-ins (`node:fs`, `node:test`, global `fetch`). There is no `package-lock.json`,
   and adding one needs an approved issue. If a dependency is ever approved, it is vendored and
   pinned.
2. **No third-party requests from the site.** No CDNs, web fonts, analytics or remote images.
   The only allowed cross-origin calls are navigation and form posts to `github.com` (or a
   user-supplied GHES host), and the opt-in manifest conversion `POST` to `api.github.com`.
3. **Strict CSP in a `<meta>` tag.** No inline scripts or styles and no `eval`. Keep JavaScript
   in same-origin ES modules.
4. **Never persist credentials.** The manifest callback shows the PEM, client secret and webhook
   secret once and stores nothing: no `localStorage`, no cookies, no logging.
5. **The repository holds no secrets.** Workflows use `GITHUB_TOKEN` only, with least-privilege
   `permissions:` blocks.
6. **Pin every GitHub Action to a full commit SHA**, with the version in a trailing comment
   (`uses: actions/checkout@<sha> # v7.0.1`). Never use a tag or branch reference.

## Domain facts that drive the design

Verify these against GitHub's docs before you rely on them in code.

- GitHub offers two ways to pre-fill app registration:
  - **URL parameters (GET)** to `/settings/apps/new`, `/organizations/ORG/settings/apps/new` or
    `/enterprises/ENT/settings/apps/new`. This works for every owner type and no secrets reach
    the page. It's the **default launcher**.
  - **Manifest (POST)** to the user or org URL only. **Manifests are not available for
    enterprise-owned apps.** GitHub redirects back with a `code`, which must be exchanged
    within one hour, once, via `POST /app-manifests/{code}/conversions`. The response contains
    the PEM and secrets. This launcher is **opt-in**.
- A webhook secret can't be preset through URL parameters.
- Manifests apply only when the app is created, so existing apps don't receive later permission
  changes. That's why entries carry a changelog and a `last_verified` date.
- GitHub always adds `metadata: read`. Webhook events need matching permissions, and the
  validator must reject entries whose events exceed their permissions.
- GitHub doesn't rank permissions by risk. byoghapp's tiers (critical, high, medium, low) come
  from one shared table, `data/permissions.json`. Never hand-write risk text in an entry.

## Planned layout

```
entries/<slug>.json         one product per file; GitHub's manifest shape kept intact under "manifest"
data/permissions.json       permission key -> display name, tier, blast radius, docs link
data/categories.json
schema/entry.schema.json
site/                       index.html, app.js, callback.html, style.css; registry.json is generated, never committed
scripts/                    build, validate and verify scripts (Node built-ins only), plus repo checks
.github/workflows/          CI, CodeQL, Scorecard, later validate/verify/pages
```

## Working rules for agents

- **Planning and notes stay out of git.** Don't create or commit `TASKS.md`, `TODO.md`,
  `PLAN.md`, notes, or research or summary documents. Put scratch work in `.scratch/`, which is
  gitignored. Track work in GitHub Issues. CI fails if these files are committed.
- **Keep diffs small and on topic.** Don't reformat unrelated files or make speculative
  refactors.
- **Don't invent registry data.** Every permission, event and URL in an entry must come from the
  vendor's documentation and GitHub's documentation. If you can't verify a value, leave it out
  and say so in the pull request.
- **Write tests with `node:test`.** Prefer small, plain functions that are easy to test.
- **Run the checks before you push:** `node scripts/check-repo-hygiene.mjs`, plus whatever the
  validator and test commands are once they exist.
- **Commits:** imperative mood. Add an AI attribution trailer such as `Co-Authored-By:` or
  `Assisted-by:` if your tool does. Never add `Signed-off-by:` for a human; the DCO sign-off is
  theirs to make.
- **Pull requests:** fill in `.github/PULL_REQUEST_TEMPLATE.md`, including the AI disclosure.
- **Never** weaken the CSP, add a network origin, add a dependency, add a secret, or broaden
  workflow `permissions:` without an issue that approves it.
