---
"@attalabs/vinaya": patch
"@attalabs/aeg-core": patch
---

Approvals carry across a v2 conflict merge that leaves the pull request's own lines unchanged. The pull request's own patch is now compared with zero context from each head's own merge base, so a merge of the default branch that only moves or surrounds the pull request's changes keeps the review; the CI review gate recomputes that comparison from the git objects itself. A merge that changes the pull request's own lines is reviewed by its interdiff against the posted approvals.
