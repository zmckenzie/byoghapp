# Security Policy

byoghapp helps people create GitHub Apps that hold real credentials. Security reviewers at
large organizations are part of the intended audience, so this document describes both how to
report a vulnerability and the security posture the project commits to.

## Reporting a vulnerability

**Please do not open a public issue, discussion or pull request for a security problem.**

Report it privately through GitHub's private vulnerability reporting:

1. Go to the [Security tab](https://github.com/zmckenzie/byoghapp/security) of this repository.
2. Click **Report a vulnerability**.

Include what you found, how to reproduce it, and the impact you expect. We aim to:

- acknowledge your report within **5 business days**,
- send an initial assessment within **10 business days**, and
- fix confirmed issues and publish a GitHub Security Advisory, crediting you unless you prefer
  otherwise.

byoghapp is a volunteer-run project and these targets are best effort.

### In scope

- The byoghapp site, including the launchers and the manifest callback page.
- Scripts and GitHub Actions workflows in this repository.
- **Registry entries that are dangerous**, for example an entry whose permissions are far
  broader than the vendor documents, or whose URLs point somewhere other than the vendor.

### Out of scope

- Vulnerabilities in a vendor's product. Report those to the vendor.
- Vulnerabilities in GitHub itself. Report those through the
  [GitHub Bug Bounty](https://bounty.github.com/).

## Supported versions

byoghapp is a continuously deployed static site. Only the current `main` branch, the site
deployed from it and the latest release are supported.

## Verifying a release

Each [release](https://github.com/zmckenzie/byoghapp/releases) publishes:

- `byoghapp-site-<version>.tar.gz`, the site ready to serve;
- `byoghapp-registry-<version>.json`, the registry data on its own;
- `SHA256SUMS`;
- `byoghapp-<version>.sigstore.json`, a Sigstore-signed
  [SLSA build provenance](https://slsa.dev/provenance) attestation for both files.

The release workflow (`.github/workflows/release.yml`) builds them from the released commit and,
only after a maintainer approves the `release` environment, signs the provenance with its GitHub
Actions identity. A file that verifies was built by this repository's workflow from that commit. To check a download with the
[GitHub CLI](https://cli.github.com/):

```sh
gh attestation verify byoghapp-site-0.1.0.tar.gz --repo zmckenzie/byoghapp
# or offline, with the bundle from the release:
gh attestation verify byoghapp-site-0.1.0.tar.gz --repo zmckenzie/byoghapp \
  --bundle byoghapp-0.1.0.sigstore.json
sha256sum --check SHA256SUMS
```

Builds are reproducible: the archive and `registry.json` depend only on the commit, so you can
rebuild a release from its tag and compare checksums.

## Security posture

The commitments below are design requirements, enforced in CI where possible
(`scripts/lint-site.mjs` checks the CSP and URL allowlist on every pull request). Pull requests
that break them won't be merged.

**The repository holds no secrets.** Every workflow runs on the built-in `GITHUB_TOKEN` with
least-privilege permissions. No API keys, deploy keys or personal access tokens are stored. The
`/verified` comment workflow only runs for code owners and executes the default branch's
scripts. It never checks out the pull request: it reads the entries through the API at the
commit it planned against, and its stamp commit only lands as a fast-forward from that commit.

**No third-party requests from the site.** The site loads no CDN scripts, fonts, analytics or
trackers, and doesn't fetch vendor logos live. All assets are served from the same origin.

**A strict Content Security Policy** is set in a `<meta>` tag on each page, because GitHub Pages
can't set response headers. It allows scripts, styles and images from the same origin only. The
registry page may only fetch from its own origin and post forms to `github.com` or `*.ghe.com`;
the manifest callback page may only call `api.github.com` or `api.*.ghe.com` and posts no forms.
Both pages send no referrer.

**The default launcher never handles credentials.** "Open in GitHub" is a plain link to GitHub's
own registration form. You review every value, set your own webhook secret, and generate the
private key inside GitHub.

**The manifest launcher is opt-in and keeps nothing.** If you choose it, GitHub sends a one-time
code back to the site. Only after you click does your browser exchange that code with
`api.github.com` for the app's credentials. The private key and secrets are shown once for you
to download. They are never stored, logged or sent anywhere else, and they are cleared when you
leave the page.

**Zero runtime dependencies.** The site and tooling use only the web platform and Node.js
built-ins, so nothing from npm reaches the site or runs in its build. The only npm package is the
fuzzing engine (Jazzer.js), a dev dependency pinned in `package-lock.json`, reviewed by
dependency review and updated by Dependabot.

**Fuzzing.** Jazzer.js fuzzes the YAML parser and the entry renderer on every pull request and
weekly (`fuzz/`, `.github/workflows/fuzz.yml`); `.clusterfuzzlite/` builds the same targets with
the OSS-Fuzz images.

**Pinned automation.** Every GitHub Action is pinned to a full commit SHA and kept up to date by
Dependabot. The repository is monitored by
[OpenSSF Scorecard](https://scorecard.dev/viewer/?uri=github.com/zmckenzie/byoghapp) and CodeQL.

**Entries are verified by people.** Each entry links to the vendor's documentation and records
when it was last checked and by whom. A scheduled job flags entries whose source documentation
has changed. It opens an issue for a person to review and never edits an entry automatically.
Every change to `entries/` needs a maintainer's approval.
