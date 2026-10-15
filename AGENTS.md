# AGENTS.md

These are instructions for AI coding agents (Claude Code, GitHub Copilot, Codex, Cursor, Gemini
and others) and for the people who use them. Human contributors should read
[CONTRIBUTING.md](CONTRIBUTING.md) first. Everything here applies to humans as well.

## Project

byoghapp ("Bring Your Own GitHub App") is an open registry of GitHub App definitions that users
create and own themselves. Each vendor that asks customers to register their own GitHub App gets
one JSON entry. A static site renders each entry with a permission risk summary and launchers
that open GitHub's pre-filled "new app" form.

**Status: pre-MVP.** The registry, validator, site and automation work; the seed entries are
marked `needs-review` until a maintainer verifies them.

## Commands

All commands use Node.js 22+ built-ins; there is nothing to install.

| Command | What it does |
| --- | --- |
| `npm test` | Unit tests (`node --test`) |
| `npm run coverage` | Unit tests with the 90% line, branch and function coverage gate |
| `npm run test:e2e` | Browser tests in headless Chrome (needs Chrome; set `CHROME_PATH`), with a 90% coverage gate for `site/app.js` and `site/callback.js` |
| `npm run mutation` | Mutation testing, 80% minimum score (`-- --file <path>` or `-- --changed origin/main` to narrow it) |
| `npm run validate` | Validate every entry (`-- --base origin/main --pr-author <login> --online` for PR rules) |
| `npm run build` | Write `site/registry.json` (generated, never committed) |
| `npm run lint:site` | Check CSP tags, inline code and URL allowlist in `site/` |
| `npm run check` | Hygiene, validate, build and lint in one go |
| `npm run serve` | Serve `site/` at http://127.0.0.1:8000 (run `npm run build` first) |

Run `npm run check && npm run coverage` before you push. Run `npm run mutation -- --changed origin/main`
when you change code under `scripts/` or `site/lib/`.

## Layout

```
entries/<slug>.json         one product per file; GitHub's manifest shape kept intact under "manifest"
data/permissions.json       permission key -> name, scope, levels with tier and blast radius, docs link
data/events.json            webhook event -> permissions that allow subscribing to it
data/categories.json        category key -> label
schema/entry.schema.json    the entry schema (checked by scripts/lib/json-schema.mjs)
site/                       index.html, callback.html, app.js, callback.js, style.css
site/lib/                   pure modules shared by the browser and Node: risk, launch, callback, search, render
scripts/                    validate, build, lint-site, verify, verification-issues, stamp-verified, mutation, serve
scripts/lib/                schema checker, entry rules, repo/git access, GitHub client, mutation core
test/scripts, test/site     unit tests (node:test); test/helpers.mjs builds fixtures
test/e2e/                   browser tests over the Chrome DevTools Protocol (test/e2e/cdp.mjs)
```

Keep logic in `site/lib/` and `scripts/lib/` as pure functions; keep `site/app.js`,
`site/callback.js` and each script's `main()` thin.

## Non-negotiable design rules

1. **Zero dependencies.** No npm packages at runtime, build or test time. Use the web platform
   and Node.js built-ins (`node:fs`, `node:test`, global `fetch`, global `WebSocket`). There is
   no `package-lock.json`, and adding one needs an approved issue. If a dependency is ever
   approved, it is vendored and pinned.
2. **No third-party requests from the site.** No CDNs, web fonts, analytics or remote images.
   The only allowed cross-origin calls are navigation and form posts to `github.com`, `*.ghe.com`
   (or a user-supplied GHES host for plain links), and the opt-in manifest conversion `POST` to
   `api.github.com` or `api.*.ghe.com`.
3. **Strict CSP in a `<meta>` tag**, exactly as listed in `scripts/lint-site.mjs`. No inline
   scripts or styles, no `style=` or `on*=` attributes, no `eval`.
4. **Escape everything.** Entries are contributed data. Every value rendered into HTML goes
   through `esc()` or `safeUrl()` in `site/lib/render.js`.
5. **Never persist credentials.** The manifest callback shows the PEM, client secret and webhook
   secret once and stores nothing: no `localStorage`, no cookies, no logging. Only the CSRF state
   goes in `sessionStorage`, and it is removed when used.
6. **The repository holds no secrets.** Workflows use `GITHUB_TOKEN` only, with least-privilege
   `permissions:` blocks. Workflows triggered by comments run the default branch's scripts and
   treat pull request files as data.
7. **Pin every GitHub Action to a full commit SHA**, with the version in a trailing comment
   (`uses: actions/checkout@<sha> # v7.0.1`).

## Testing standards

- New code needs tests. Coverage must stay at or above 90% for lines, branches and functions,
  and the mutation score at or above 80%.
- A surviving mutant means a behaviour no test checks: add an assertion that would fail. Only
  mark a line `// mutation-ignore` when the mutant is provably equivalent, and say why in the
  comment.
- Tests never touch the network or the real entries' contents: use `test/helpers.mjs`
  (`makeEntry`, `fixtureRepo`, `fakeFetch`, `fakeServer`).

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
- A webhook secret can't be preset through URL parameters, and `public` is ignored for
  enterprise-owned apps.
- Manifests apply only when the app is created, so existing apps don't receive later permission
  changes. That's why entries carry a changelog.
- GitHub always adds `metadata: read`. Webhook events need matching permissions
  (`data/events.json`), and the validator rejects entries whose events exceed their permissions.
- GitHub doesn't rank permissions by risk. byoghapp's tiers come from `data/permissions.json`.
  Never hand-write risk text in an entry.

## Working rules for agents

- **Planning and notes stay out of git.** Don't create or commit `TASKS.md`, `TODO.md`,
  `PLAN.md`, notes, or research or summary documents. Put scratch work in `.scratch/`, which is
  gitignored. Track work in GitHub Issues. CI fails if these files are committed.
- **Keep diffs small and on topic.** Don't reformat unrelated files or make speculative
  refactors.
- **Don't invent registry data.** Every permission, event and URL in an entry must come from the
  vendor's documentation, and you must have read that page. If you can't verify a value, leave it
  out and say so in the pull request. Never set `last_verified`, `verified_by` or
  `verification.status: "ok"`: maintainers record verification with `/verified`.
- **Commits:** imperative mood. Add an AI attribution trailer such as `Co-Authored-By:` or
  `Assisted-by:` if your tool does. Never add `Signed-off-by:` for a human; the DCO sign-off is
  theirs to make.
- **Pull requests:** fill in `.github/PULL_REQUEST_TEMPLATE.md`, including the AI disclosure.
- **Never** weaken the CSP, add a network origin, add a dependency, add a secret, or broaden
  workflow `permissions:` without an issue that approves it.
