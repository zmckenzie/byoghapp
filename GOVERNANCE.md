# Governance

byoghapp is a small project run by one maintainer, which the project calls a
benevolent-dictator model. This document says how decisions are made and how that can change as
the project grows.

## Roles

- **Contributors:** anyone who opens an issue, reviews a pull request, or submits a change.
- **Maintainers:** people with write access who review and merge pull requests, verify registry
  entries, and triage issues. Maintainers are listed in [CODEOWNERS](.github/CODEOWNERS).
- **Lead maintainer:** [@zmckenzie](https://github.com/zmckenzie). The lead maintainer makes
  final decisions when consensus isn't reached.

## Decisions

- Most decisions happen in issues and pull requests, and maintainers aim for consensus.
- Changes to the security posture in [SECURITY.md](SECURITY.md), to the design rules in
  [AGENTS.md](AGENTS.md) or to this document need an issue that stays open for comment for at
  least 7 days before merging. Urgent security fixes are the exception.
- Every pull request needs approval from a maintainer who didn't author it. Until there are two
  maintainers, the lead maintainer's own pull requests get at least one automated review and run
  all required checks.

## Becoming a maintainer

Contributors who have made sustained, high-quality contributions, such as entries, reviews or
code, may be invited by the existing maintainers. Vendors may be invited to co-own their own
entries under `entries/`.

## Vendor neutrality

byoghapp doesn't accept payment for listing, ranking or wording of entries. Vendors may submit
and maintain their own entries through the same review process as everyone else. The risk
summary is computed from shared rules and can't be adjusted for each vendor.
