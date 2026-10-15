# byoghapp

**Bring Your Own GitHub App:** an open registry of GitHub App definitions that you create and own.

[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/zmckenzie/byoghapp/badge)](https://scorecard.dev/viewer/?uri=github.com/zmckenzie/byoghapp)
[![CI](https://github.com/zmckenzie/byoghapp/actions/workflows/ci.yml/badge.svg)](https://github.com/zmckenzie/byoghapp/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

> [!NOTE]
> **Status: pre-MVP.** The registry, site and automation work, and the first 11 entries are in.
> No entry has been verified by a maintainer yet: check permissions against the vendor's docs
> before you create an app.

## Why

Dozens of tools (Backstage, Renovate, Atlantis, Terraform Enterprise, Sourcegraph, Claude Code,
CodeRabbit, and more) ask you to register **your own** GitHub App instead of installing theirs.
Each vendor documents the required permissions and webhook events differently. Some list
nothing, some contradict themselves, and almost none cover enterprise-owned apps.

byoghapp collects those definitions in one place, in one format, with:

- **A permission risk summary** for every entry, computed from a single shared table rather than
  written by hand for each vendor.
- **One-click launchers** that open GitHub's own "new app" form pre-filled for a personal account,
  an organization, an enterprise, or a GitHub Enterprise Server host.
- **Provenance and drift tracking**: a link to the vendor's documentation, a `last_verified`
  date, and a changelog, so you can compare an app you created months ago with the current
  definition.

## How it works

Each product is one YAML file in `entries/`. The static site renders each entry with two
launchers:

| Launcher | Works for | Secrets touch the page? |
| --- | --- | --- |
| **Open in GitHub** (default): a URL-parameter link | User, organization, enterprise, GHES | Never |
| **Create from manifest** (opt-in) | User and organization only | Yes, once, in your browser, never stored |

The site is plain HTML, CSS and JavaScript with **zero runtime or build dependencies**, served
from GitHub Pages under a strict Content Security Policy. It makes no third-party requests, uses
no analytics, and the repository holds no secrets. See [SECURITY.md](SECURITY.md) for the full
security posture.

Each entry page shows:

- the permissions with their risk tier (critical, high, medium, low), what each one allows, and
  a link to GitHub's reference;
- the webhook posture, the install scope, the credentials the vendor needs, and the steps
  GitHub's form can't do;
- a changelog, a "Report a problem" link, and whether a maintainer has verified the entry.

A weekly job re-reads every vendor's documentation and opens an issue when the permission text
changes. A maintainer reviews it and records the verification with `/verified`.

## Try it locally

You need Node.js 22.12 or newer and nothing else.

```sh
npm run build    # writes site/registry.json from entries/
npm run serve    # http://127.0.0.1:8000
```

## Contributing

Contributions are welcome, from adding a vendor entry (a short pull request) to working on the
site and tooling. Start with [CONTRIBUTING.md](CONTRIBUTING.md).

**AI-assisted contributions are welcome.** The repository includes [AGENTS.md](AGENTS.md) so
coding agents (Claude Code, GitHub Copilot, Codex, Cursor and others) can work here
effectively. See [the AI policy](CONTRIBUTING.md#using-ai-tools) for what we expect from
AI-assisted pull requests.

Planning happens in [GitHub Issues](https://github.com/zmckenzie/byoghapp/issues) and
Projects, not in files in the repository.

## Security

Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Don't open a
public issue for them.

## License

Code and registry data are licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE).

byoghapp is an independent community project. It is not affiliated with or endorsed by GitHub or
by any vendor listed in the registry.
