---
"@attalabs/vinaya": patch
"@attalabs/aeg-core": patch
---

Which severities block is now repository policy, not a fixed rule: `vinaya.config.json`'s new `reviewPolicy` field carries two separate thresholds, `codeReviewThreshold` (over `BLOCKER > MAJOR > MINOR`) and `securityThreshold` (over `CRITICAL > HIGH > MEDIUM > LOW`) — a finding at or above the threshold blocks. An omitted policy keeps today's behaviour (`BLOCKER`/`HIGH`); a present-but-unknown severity value refuses at config load rather than silently falling back. This repository is configured to `MAJOR`/`HIGH`.

One pure evaluator (`@attalabs/aeg-core`'s new `review-policy.ts`: `evaluateCodeReview`/`evaluateSecurityReview`/`evaluateReviewFindings`) now sits behind every site that derives, accepts, or judges a verdict — `vinaya review post`'s derivation and its round-two contradiction/delta checks, the dev-review-loop's round assessment (`buildVerdictFromReport`) and its publication self-check (`publishRound`), and the merge gate (`checkReviewGate`) — so no path can apply a weaker rule than another. A reviewer's own `APPROVE`/`PASS` never overrides the evaluator: a verdict comment whose text claims clean but whose own FINDINGS block carries a finding at or above the threshold is refused before posting, refused before publication, and read as not clean by the merge gate. The gate and the loop resolve policy from the SAME source — the default branch's `vinaya.config.json` — never the PR's own checkout, so a change cannot lower its own threshold.
