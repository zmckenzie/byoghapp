# Repository settings

Some open-source and OpenSSF Scorecard practices are GitHub settings rather than files. This page
records the intended configuration so it can be reviewed and rebuilt. Change this page
whenever a setting changes.

## General

| Setting | Value | Why |
| --- | --- | --- |
| Default branch | `main` | |
| Features | Issues and Projects on. Wiki off. Discussions optional | Planning lives in Issues and Projects |
| Pull requests | Squash merge only. Auto-delete head branches | Clean history |
| Require contributors to sign off on web-based commits | On | DCO, see CONTRIBUTING.md |

## Security (Settings → Code security)

| Setting | Value | Scorecard check |
| --- | --- | --- |
| Private vulnerability reporting | On | Security-Policy |
| Dependabot alerts and security updates | On | Vulnerabilities |
| Dependency graph | On | |
| Secret scanning and push protection | On (free for public repositories) | |
| Code scanning | CodeQL through `.github/workflows/codeql.yml` (advanced setup) | SAST |

## Branch ruleset for `main` (Settings → Rules)

| Rule | Value | Scorecard check |
| --- | --- | --- |
| Restrict deletions and block force pushes | On | Branch-Protection |
| Require a pull request before merging | 1 approval. Dismiss stale approvals. Require Code Owners review. Require approval of the most recent push | Branch-Protection, Code-Review |
| Require conversation resolution | On | |
| Required status checks | `Repository checks and tests`, `Browser tests`, `Workflow security (zizmor)` and `Validate changed entries`, plus `Analyze (actions)`, `Analyze (javascript-typescript)` and `Dependency review` once the repository is public. `Mutation testing` only runs when code changes, so leave it optional | Branch-Protection, CI-Tests |
| Copilot code review | On, with "Review new pushes" | Comment only. It never counts as an approval |
| Bypass list | Empty. Repository admins aren't exempt | Branch-Protection |

While the project has a single maintainer, a required approval from someone other than the
author can't be met. Until a second maintainer joins, either add the lead maintainer to the
bypass list for pull requests only, or set the required approvals to 0 and rely on the required
checks and Copilot review. Record which option was chosen here.

## Actions (Settings → Actions → General)

| Setting | Value |
| --- | --- |
| Workflow permissions | Read repository contents (read-only `GITHUB_TOKEN` by default) |
| Allow GitHub Actions to create and approve pull requests | Off (the `/verified` workflow pushes commits and comments; it never opens or approves pull requests) |
| Require approval for workflows from outside collaborators | All outside collaborators |
| Allowed actions | GitHub-created actions, plus `ossf/*`, `step-security/*` and `zizmorcore/*` |

## Labels

The issue forms and Dependabot use these labels: `bug`, `enhancement`, `triage`, `new-entry`,
`entry-problem`, `verification-failed`, `dependencies`, `good first issue`, `help wanted`.

## Pages

Settings → Pages → Source: **GitHub Actions**. `.github/workflows/pages.yml` deploys `site/` on
every push to `main` once the repository is public.

## Making the repository public

When the repository becomes public, the Scorecard, CodeQL and Dependency review workflows start
running automatically, because each is gated on `!github.event.repository.private`. After the
first Scorecard run, the README badge shows a score. Then:

1. Add the CodeQL and Dependency review checks to the required status checks in the ruleset.
2. Enable secret scanning and push protection.
3. Register the project with the [OpenSSF Best Practices badge](https://www.bestpractices.dev/),
   which Scorecard's CII-Best-Practices check reads, and add the badge to the README.
4. Set a dedicated contact address for Code of Conduct reports in `CODE_OF_CONDUCT.md`.
