---
applyTo: "entries/**"
---

# Reviewing registry entries

An entry is one YAML file describing the GitHub App a vendor asks customers to create.
People use it to grant permissions to a third party, so accuracy matters more than
completeness. CI (`scripts/validate.mjs`) enforces the schema and cross-checks. When
reviewing, focus on what CI can't judge:

1. **Every value is backed by the vendor's own documentation.** `documentation_url` (and any
   `documentation_urls`) must be the vendor's page, and it must state each permission, level
   and webhook event in the manifest. Flag any value you can't find on that page.
2. **No extra permissions.** Flag permissions or levels beyond what the vendor documents,
   especially write access, `administration`, `secrets`, `workflows`, `members` or
   `organization_*` permissions.
3. **Variants are honest.** Each variant should match a feature set the vendor's docs
   describe. `variants[0]` must equal `manifest`.
4. **Webhook URLs.** A real URL must belong to the vendor. A URL that depends on the
   customer's own host, or is only known after setup, must be a placeholder under
   `https://example.invalid/` with `two_step_webhook: true`.
5. **Manual steps** are short, imperative and only cover what GitHub's form can't pre-fill.
6. **Verification fields.** Contributors must not set `last_verified`, `verified_by` or
   `verification.status: "ok"`; a maintainer records verification with `/verified`. A change
   to `manifest` or `variants` needs `verification.status: "needs-review"`.
7. **Changelog.** Every change adds one new line at the top with a higher version, today's
   date and the pull request author's login. Older lines are never edited.
8. **Neutral wording.** Notes describe facts and contradictions in the vendor's docs. No
   marketing, rankings or opinions about the vendor.
