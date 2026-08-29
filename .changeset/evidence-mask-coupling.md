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
  count that goes stale. It is exempt from the digit check and byte-compared
  by the freshness check, both naming the line through one selector.
- `check-evidence-fresh` now refuses, rather than passing silently, when the
  only `AEG:EVIDENCE` pair sits inside a `<details>` block — where the digit
  check blanks every digit and nothing can verify what it claims.
- `vinaya pr report --write` refuses a body whose anchor resolves one way
  before normalisation and another after, instead of appending a second block
  beside a hidden one.
