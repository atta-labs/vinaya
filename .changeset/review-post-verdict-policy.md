---
"@attalabs/vinaya": minor
---

`vinaya review post` now derives the verdict instead of taking it on faith: `--verdict` is optional, and the command computes REQUEST_CHANGES/FAIL from the findings file (a BLOCKER, or a CRITICAL/HIGH, forces it; their absence forces APPROVE/PASS) — an explicit `--verdict` that disagrees is refused before posting anything, naming the derived value.

`--escalate authority | strategy | product --summary <text>` posts an `ESCALATE: <class>` comment as its own review outcome — never a finding stuffed inside a REQUEST CHANGES or FAIL. It renders no line the merge gate's extractors read as a verdict, is refused together with `--verdict` or with a blocking finding in the findings file, and self-verifies the inverse of a normal post: that neither `extractCodeReviewVerdict` nor `extractSecurityReviewVerdict` reads it as a verdict at all.

Round two is now mechanically gated: when the PR already carries a same-role verdict comment from an allowlisted author, the new findings file must carry every prior `F<n>` id with a state (`open`/`fix-claimed`/`reproduced`/`resolved`) in its description, and every non-blocking finding must fall inside the diff (`git diff <judged-head>...HEAD -U0`) since that comment's `Judged head:` line — a dropped id or an out-of-delta non-blocking finding is refused before posting. A BLOCKER/CRITICAL/HIGH is always accepted regardless of delta.

`aeg-root/roles/reviewer.md` and `aeg-root/roles/security.md` are updated to describe only what the command now enforces.
