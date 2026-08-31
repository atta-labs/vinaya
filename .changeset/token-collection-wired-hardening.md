---
"@attalabs/vinaya": patch
"@attalabs/aeg-core": patch
---

`token-collection-wired` review follow-ups.

The pointer file sits at a fully predictable path in a directory other local
users can usually write to, and this check is what makes it read automatically,
unattended, on every commit and push in every adopter. The read is now
`lstat`-guarded: a symlink, a non-regular file, or a file owned by another user
is treated as no pointer at all rather than followed. The repo had already
accepted this threat model on the writer side — `claude-stop-hook-emitter.ts`
records a prior review's CWE-59 finding and hardens the write — and the read side
had inherited the threat with none of the hardening.

The second `packages/aeg-core/bin/check-token-collection-wired.ts` gate is
removed. It shipped to nobody (`aeg-core`'s `files` is `["src", …]`) and existed
only so the registry scaffold's classifier had a candidate, which made the
doctrine row cite a path no adopter has. The row now cites the shipped
`apps/cli` check directly, as `main-branch-refusal`'s row does. Whether the
predicate itself should also move out of `aeg-core` now that the scaffold
argument for keeping it there is gone is a separate, still-open question
(issue #307) — not decided or settled by this change.

`isTokenCollectionWiringBroken` briefly became a type predicate in this branch
and was reverted before release: as a predicate it was unsound, since `false`
also covers the sanctioned incapable case, so the negative branch narrowed to
`capable: true` and a `.summary` dereference compiled clean while throwing at
runtime. It ships as a plain boolean. Recorded here because these notes are the
published changelog and a reader must not be told a predicate exists.
