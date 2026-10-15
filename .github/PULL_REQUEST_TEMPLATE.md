## Summary

<!-- What does this change, and why? Link the issue it resolves. -->

Closes #

## Type of change

- [ ] Registry entry (new or updated)
- [ ] Site or tooling
- [ ] CI, automation or repository configuration
- [ ] Documentation

## Checklist

- [ ] I have read [CONTRIBUTING.md](../CONTRIBUTING.md), and my commits are signed off (`git commit -s`).
- [ ] The change is focused, and CI passes locally (`node scripts/check-repo-hygiene.mjs`, `node --test`).
- [ ] No new dependencies, network origins, secrets or broader workflow permissions (or an approved issue is linked).
- [ ] No planning, notes or research files are included (`TASKS.md`, `TODO.md`, `PLAN.md` and so on).

### For registry entries

- [ ] Every permission, event and URL comes from the vendor's documentation, linked in `documentation_url`.
- [ ] Every webhook event has the permission it needs.
- [ ] `last_verified` is today or earlier, and the `changelog` has a new line for this change.

## AI disclosure

<!-- See CONTRIBUTING.md#using-ai-tools. Disclosure doesn't count against a contribution. -->

- [ ] No AI tools were used beyond autocomplete.
- [ ] AI tools were used. Tool or tools, and what they did:

I have reviewed, understood and tested every line of this change, and I'm responsible for it.
