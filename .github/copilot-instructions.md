# Copilot instructions

The full rules for all coding agents are in [AGENTS.md](../AGENTS.md) at the repository root.
Follow them. The points below matter most, both when you write code and when you review a pull
request.

When writing code:

- Add no npm dependencies. Use web platform APIs and Node.js built-ins only; the fuzzing engine
  (Jazzer.js, a dev dependency) is the one approved exception.
- The site makes no third-party requests and runs under a strict CSP, so don't use inline
  scripts or styles, `eval`, CDNs, web fonts or analytics.
- Never store or log GitHub App credentials (PEM, client secret, webhook secret).
- Pin GitHub Actions to a full commit SHA with a version comment, and keep workflow
  `permissions:` least-privilege.
- Don't commit planning or scratch files (`TASKS.md`, `TODO.md`, `PLAN.md`, notes, research).

When reviewing a pull request, flag:

- New dependencies, new network origins, CSP changes, or broader workflow permissions.
- Registry entry values that have no link to vendor documentation backing them.
- Webhook events that need a permission the entry doesn't request.
- Committed scratch or planning files, credentials, or `.env` files.
- A missing AI disclosure in the pull request template when the change looks AI-generated.
