---
"@attalabs/vinaya": minor
"@attalabs/aeg-core": minor
---

`vinaya issue create`/`vinaya issue edit` now refuse a task Issue whose `## Surface` `in:` glob matches no tracked file (naming the glob), whose `## Parts` cite an `O<n>` the Issue's own `## Objectives` never defines (naming the part and the citation), and whose "Docs to keep coherent" field names a path outside its own `## Surface` `in:` globs or inside its `out:` globs (naming the pointer and the excluding glob). The Surface-glob resolution predicate is injected from the caller (`forge-write.ts`'s `expandGlob`) — the same implementation `brief-assembly.ts`'s render path already uses — so the authoring gate and the brief renderer can never disagree about whether a glob resolves.

For a task Issue at or above the brief-sections cutover (`BRIEF_SECTIONS_SINCE_ISSUE`), `checkBlastRadiusScope` now decides an under-declared blast radius from the `## Surface` `in:` glob list alone, never from a prose scan of the rationale — naming a shared package in order to explicitly exclude it can no longer trip the gate. Below the cutover, the original prose scan is unchanged.

A dot-prefixed directory (`.claude`, `.github`) is now usable in a `## Surface` glob: the file-path heuristic no longer misreads a dot-directory's leading dot as a file extension.
