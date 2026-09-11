---
"@attalabs/vinaya": patch
"@attalabs/aeg-core": patch
---

The dev-review-loop and `review post` now build one `ReviewInputManifest` (head, the frozen brief's own hash, objectives version, newest ruling ordinal, and the effective review policy's digest) before dispatching reviewers, and render it into every verdict/escalation comment: `Brief hash:` and `Policy digest:` now render unconditionally, right after `Ruling ordinal:`. The merge gate (`checkReviewGate`, now accepting an optional `briefHash`) and the loop's own publication self-check both compare a verdict's echoed manifest fields to the current one through the same `compareManifest` function, so a Planner superseding the frozen brief mid-round (`'brief_superseded'`) or a policy change (`'policy_changed'`) invalidate a held verdict the same way an objectives edit or a new ruling already did. Every prior binding (head/patch-identity, objectives version, ruling ordinal) is unchanged in meaning and outcome; a comment predating this change (no `Brief hash:`/`Policy digest:` line) is grandfathered, never treated as a mismatch.
