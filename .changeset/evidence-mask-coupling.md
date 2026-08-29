---
"@attalabs/vinaya": patch
---

`body-bare-digits` and `check-evidence-fresh` now resolve the anchored
`AEG:EVIDENCE` region through one shared, nominally-typed context instead of
each deriving it from its own text. They disagreed: the digit check normalised
the body first (zero-width strip, named-entity decode) while the freshness
check read the raw PR body, so one zero-width character inside the START
marker made the digit check exempt a block the freshness check could not see
at all — two green checks over an unverified figure.

Also in this change:

- `vinaya pr report` emits a `Summary:` line derived from the numstat the
  block already carries, so a PR body no longer needs a hand-written file
  count that goes stale. Its value is emitted inside an inline code span, so
  it needs no new `body-bare-digits` exemption — which also means it works
  under a checker that predates it, as the `pull_request_target` workflow
  running from the default branch requires. The freshness check byte-compares
  the whole line.
- `check-evidence-fresh` now refuses, rather than passing silently, when the
  only `AEG:EVIDENCE` pair sits inside a `<details>` block — where the digit
  check blanks every digit and nothing can verify what it claims.
- `vinaya pr report --write` refuses a body whose anchor resolves one way
  before normalisation and another after, instead of appending a second block
  beside a hidden one.
