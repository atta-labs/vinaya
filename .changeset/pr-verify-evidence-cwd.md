---
"@attalabs/vinaya": patch
"@attalabs/vinaya-sources": patch
---

`pr verify-evidence` now refuses unless run from the repository root.

The regeneration inherits the process working directory — `buildReport()` spawns
the gate suite with `cwd: process.cwd()` — and several gates resolve their scan
root from it. Run from a subdirectory there is no `aeg-root/` above them, so
`reader-resolvable-prose` collects nothing and `registry-gates` reports itself
dormant: an entire class of findings vanishes from the regenerated Group B with
no error, and a published block with exactly those findings deleted compares
MATCH.

Two reviewers demonstrated it independently at the same head, on a clean tree
with the correct head and no `BASE_SHA`. A fabricated block reported DIFFERS
naming every deleted warning from the repository root, and MATCH from
`apps/cli`. Only the working directory changed.

The command already pinned its `git status` check to the repository root, with a
comment saying a subdirectory invocation must not narrow what is inspected. That
reasoning had been applied to the cheap half and not to the half that decides the
verdict.

It refuses rather than changing directory: a silent `chdir` would make the
command quietly do something other than what the caller asked, and a refusal
cannot manufacture a MATCH — the failure direction that matters here.
