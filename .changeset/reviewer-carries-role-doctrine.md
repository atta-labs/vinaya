---
'@attalabs/vinaya': patch
'@attalabs/aeg-core': patch
---

Reviewer and security passes the review loop dispatches now carry their own role doctrine — the role's short version and its "What you check" list — instead of a one-line role label.

`@attalabs/aeg-core` gains `extractShortVersionAndChecklist`, a pure extractor that returns a role document's short version (with its trailing `---` rule stripped) plus its `## What you check` section, reusing `extractShortVersion` so the injected text and the published `/docs` page can never disagree.

The dev-review-loop resolves that text through the same override-aware role plan `vinaya check --plan` renders, so an adopter's `roles` override supplies its own doctrine (`code-reviewer` resolves to `reviewer`). The text is injected as a prompt `fact` piece — the banned-framing lint never reads it, so a role text whose wording happens to match a banned phrase renders and the round proceeds — followed by one precedence sentence stating that the dispatch's own findings/report/objectives file hand-off wins over the doctrine's output wording. `RoleContract` now carries the contract body so the plan can hand an override's own prose through.
