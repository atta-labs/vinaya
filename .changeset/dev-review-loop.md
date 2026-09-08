---
"@attalabs/vinaya": minor
"@attalabs/vinaya-sources": patch
---

Adds `vinaya dev-review-loop --task <n> --agent claude | codex | gemini` — dispatches the developer through `dispatchRole` with the brief read from the task Issue's frozen `aeg:brief:v1` comment, waits for the PR it opens, then runs rounds by calling `assessRound` (`@attalabs/aeg-core`) with observations read from the forge (`git ls-remote` for the head, the check-runs API for CI, `<!-- aeg:principal:ruling:<pr>-<k> -->`-marked comments for rulings) until it returns `publish` or `pause`. Each round's reviewer and security verdicts are dispatched fresh, rendered through `review post`'s render functions, and held as local files under the outbox — nothing is posted to the PR before `publish`. The developer's own session is resumed every round via `dispatchRole`'s `resumeId`; a resume failure for a vendor that resumed successfully the round before stops the loop rather than falling back to a fresh session.
