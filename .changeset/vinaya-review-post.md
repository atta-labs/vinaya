---
"@attalabs/vinaya": minor
"@attalabs/vinaya-sources": patch
---

`vinaya review post --role code-reviewer|security` renders, posts, and self-verifies a code-review or security-review verdict comment from structured flags (verdict, findings, per-field text) instead of a hand-typed comment. It resolves the PR's real head itself (`gh pr view --json headRefOid`), renders every structural `VERDICT:`/`Judged head:` line from validated inputs — never from caller-supplied text — refuses a contradictory verdict (a BLOCKER/CRITICAL-or-HIGH finding paired with a clean verdict) before posting anything, and after posting re-fetches the comment and refuses to exit 0 unless it re-parses clean through the exact `extractCodeReviewVerdict`/`extractSecurityReviewVerdict` functions the merge gate calls. Closes the gap where a Reviewer's free-typed markdown could produce a shape the gate's line-anchored parser silently can't see, caught only by CI going red minutes later with no pointer back to what was wrong.
