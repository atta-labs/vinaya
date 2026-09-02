---
"@attalabs/vinaya": patch
---

Fixes `review-gate` failing on every PR with `review-gate severity:infra — could not fetch check-run status ... via \`gh pr checks\`.` — `#341`'s new `fetchMechanicalChecks()` calls `gh pr checks <N> --json name,bucket`, which needs the `checks: read` permission scope on the Actions token. `vinaya-review.yml`'s `permissions:` block (and its generator, `reviewWorkflow()` in `artifacts.ts`) never got that scope added alongside the new call, so it failed unconditionally for every PR opened after `#341` merged.
