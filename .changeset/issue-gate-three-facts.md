---
'@attalabs/aeg-core': patch
'@attalabs/vinaya': patch
---

`vinaya issue create` and `vinaya issue edit` now refuse three facts the Issue write gate used to pass: a `**Project:**` name with no row in `.vinaya/projects.md` (a repository with no registry is unaffected), a fenced `## Test plan` line the dispatched Developer cannot run (one that starts, briefs or dispatches a task, posts a ruling, releases, merges or reviews a pull request, pushes, or opens a remote shell), and a `## Documentation` source that is an in-repository path the checkout does not contain. Each refusal names the offending value and the edit that clears it.
