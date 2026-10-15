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

The project deliberately has **zero npm dependencies**, at runtime, build and test time.

- **Requirements:** Node.js 22.12 or newer (see `.nvmrc`), Git, and Chrome or Chromium for the
  browser tests.
- **Checks:** `npm run check` (repository hygiene, entry validation, build, site lint) and
  `npm run coverage` (unit tests with the coverage gate). [AGENTS.md](AGENTS.md#commands) lists
  every command.
- **Run the site:** `npm run build && npm run serve`, then open http://127.0.0.1:8000.

Please don't add a dependency without discussing it in an issue first. If one is ever justified,
it will be vendored and pinned, not installed from the registry at build time.

### Testing standards

- Unit tests use `node:test`. Coverage must stay at or above **90%** for lines, branches and
  functions (`npm run coverage`). The browser tests (`npm run test:e2e`) hold the browser-only
  code to the same bar.
- **Mutation testing** checks that the tests would catch real bugs: `npm run mutation` makes
  small changes to the code (flipping `<` to `<=`, `&&` to `||`, emptying strings and so on) and
  expects a test to fail for each. The score must stay at or above **80%**. Run it on what you
  changed with `npm run mutation -- --changed origin/main`; a surviving mutant names the file,
  line and change that no test noticed.

## Adding or updating an entry

1. Read the vendor's documentation for creating the GitHub App. Every permission, level and
   webhook event you add must appear there.
2. Copy a similar file in `entries/` to `entries/<slug>.json`. `slug` is lowercase with
   hyphens and must match the file name.
3. Fill in `manifest` with GitHub's manifest fields. Use a placeholder webhook URL under
   `https://example.invalid/` with `two_step_webhook: true` when the URL is only known after
   the vendor side is set up. If the vendor documents different permission sets for different
   features, add `variants` (the first must equal `manifest`).
4. Leave `last_verified` and `verified_by` as `null` and `verification.status` as
   `"needs-review"`. A maintainer verifies the entry and records it by commenting `/verified`
   on your pull request.
5. Add a line at the top of `changelog` with today's date, a higher version and your GitHub
   login (it must match the pull request author).
6. Run `npm run validate` and `npm run build`, and look at your entry with `npm run serve`.

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
