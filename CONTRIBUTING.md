# Contributing to byoghapp

Thank you for your interest in byoghapp. This guide covers how to propose changes, what we
expect in a pull request, and how we handle AI-assisted contributions.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- **Add or update a registry entry.** This is the most valuable contribution. Once the schema
  lands, adding an entry means one JSON file and a pull request.
- **Report a problem with an entry.** For example, a vendor changed its documentation or a
  permission is wrong. Use the *Report a problem with an entry* issue form.
- **Improve the site, validator or automation.** Look for issues labeled
  [`good first issue`](https://github.com/zmckenzie/byoghapp/labels/good%20first%20issue) or
  [`help wanted`](https://github.com/zmckenzie/byoghapp/labels/help%20wanted).
- **Report a security issue.** Do this privately, as described in [SECURITY.md](SECURITY.md).

## Where work is tracked

All planning, task tracking and discussion happen in **GitHub Issues and Projects**.

Do **not** commit planning or scratch files such as `TASKS.md`, `TODO.md`, `PLAN.md`, notes or
research write-ups. They are listed in `.gitignore`, and CI rejects them (see
`scripts/check-repo-hygiene.mjs`). If a document is worth keeping, it belongs in an issue, a
pull request description, or user-facing docs under `docs/`.

## Before you start

- For anything bigger than a typo or a single entry, **open an issue first** so we can agree on
  the approach before you invest time.
- Check open issues and pull requests to avoid duplicating work.

## Development

The project deliberately has **zero npm dependencies**, at runtime and at build time.

- **Requirements:** Node.js 22 LTS or newer (see `.nvmrc`) and Git.
- **Checks:** `node scripts/check-repo-hygiene.mjs` runs locally the same repository checks that
  CI runs. Further commands will be documented here as the validator and site are built.

Please don't add a dependency without discussing it in an issue first. If one is ever justified,
it will be vendored and pinned, not installed from the registry at build time.

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Keep each pull request focused on one change. Small pull requests are reviewed faster.
3. Fill in the pull request template, including the AI disclosure.
4. Make sure CI passes.
5. A maintainer review is required before merge. Automated reviewers, such as Copilot code
   review, may comment, but they never replace a human approval.

### Commit messages

Write clear, imperative commit messages, for example "Add Atlantis entry" or "Validate event
permissions". [Conventional Commits](https://www.conventionalcommits.org/) prefixes
(`feat:`, `fix:`, `docs:`, `chore:`) are welcome but not required.

### Developer Certificate of Origin (DCO)

Sign off every commit to certify that you wrote it or otherwise have the right to submit it under
the project license ([developercertificate.org](https://developercertificate.org/)):

```sh
git commit -s -m "Add Atlantis entry"
```

This adds a `Signed-off-by: Your Name <you@example.com>` line. The sign-off is **your**
certification. An AI tool cannot sign off on your behalf (see below).

## Using AI tools

AI-assisted contributions are welcome. This project is set up to work well with coding agents:
[AGENTS.md](AGENTS.md) holds the shared instructions every agent should read, and
`CLAUDE.md` and `.github/copilot-instructions.md` point to it.

What we ask:

1. **You are the author.** You are responsible for every line you submit, whether you or a tool
   wrote it. Read, understand and test the change before you open the pull request. Be ready to
   explain any part of it in review.
2. **Disclose meaningful AI use.** Tick the AI disclosure box in the pull request template and
   say briefly which tool you used and for what, for example "Claude Code drafted the validator
   tests; I reviewed and edited them." Autocomplete-level help doesn't need disclosing.
   Disclosure doesn't count against a contribution. It helps reviewers know where to look.
3. **Attribute with trailers, not sign-offs.** Agents may add a `Co-Authored-By:` or
   `Assisted-by:` trailer. Only a human adds `Signed-off-by:`.
4. **Verify facts against primary sources.** Registry entries must be checked against the
   vendor's own documentation and GitHub's documentation. Never submit permissions, events or
   URLs that a model produced without that check. Fabricated entries will be closed.
5. **No low-effort bulk pull requests.** Unreviewed, machine-generated pull requests (mass
   reformatting, speculative refactors, invented entries) will be closed without review.
6. **Respect licenses.** Don't submit generated output that reproduces third-party code or text
   under incompatible terms.
7. **Keep agent scratch files out of the tree.** Agents tend to create `TASKS.md`, `PLAN.md` or
   notes files. They belong in the gitignored `.scratch/` directory, never in a commit.

Maintainers use AI tools too, under the same rules.

## Licensing

By contributing you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE), the license that covers the project.
