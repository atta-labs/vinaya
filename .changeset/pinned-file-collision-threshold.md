---
'@attalabs/aeg-core': patch
'@attalabs/vinaya': patch
'@attalabs/vinaya-sources': patch
---

`vinaya issue create` and `vinaya issue edit` now compare the files a task Issue's **Boundary** pins against the pinned files of every other open task Issue in the repository and the changed files of every open pull request. Share `planning.collisionThreshold` files or more (default three) with one of them, and declare no `Conflicts-with` edge naming it in either direction, and the write is refused, naming the other task and every shared file.

Share fewer, and the Issue is accepted with each shared file and the task it is shared with printed as a warning. A small overlap is worth running in parallel — a merge conflict over one or two files costs minutes, while serializing a task costs a whole dispatch — so the default is deliberately permissive, and `planning.collisionThreshold: 0` turns the refusal off and leaves only the warning.

The same comparison runs when a task is dispatched, scoped to open pull requests only, and prints the same warning or refusal. Only the first fifty open pull requests are read, so a busy repository never slows `issue create` to a crawl; when that bound is reached the output says so. An Issue whose Boundary pins no resolvable file makes no forge call at all.

The existing package-level `checkConflictCompleteness` warning is unchanged and still runs — a domain overlap that shares no pinned file is still worth a hint.
