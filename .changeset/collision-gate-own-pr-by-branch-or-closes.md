---
'@attalabs/vinaya': patch
---

The pinned-file collision gate no longer counts a task's own open pull request as a colliding peer when the forge returns an empty `closingIssuesReferences` list. A pull request is recognised as the subject's own by its closing reference, by its task branch (`task/issue-<n>` or `task/<slug>/<n>`), or by a `Closes`/`Fixes`/`Resolves #<n>` line in its body — so editing a running task's Issue or superseding its brief is no longer refused by the task colliding with itself. A pull request naming no task Issue by any of the three is still compared exactly as before.
