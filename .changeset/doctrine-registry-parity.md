---
"@attalabs/aeg-core": patch
"@attalabs/vinaya": patch
---

Adds an `Audience` column (`product` | `repo-own`) to every row of `aeg-root/enforcement.md`'s three
ring tables, marking whether a row's implementation ships as a real, adopter-runnable check
(`coreCheckRegistry()`) or is specific to how this repository enforces itself on top of the product.
`registry-parse.ts` reads the column by header name, defaulting an absent column to `repo-own` — an
un-upgraded adopter copy of the doctrine is unaffected.

Adds G6, a new blocking registry check: every row marked `product` must actually resolve to a
`coreCheckRegistry()` entry. It closes the gap the tranche's own gap audit named — a doctrine row can
claim shipped enforcement that no adopter's `vinaya check` ever runs, and nothing previously compared
the two. G6 runs only from `apps/cli`'s `check-registry-gates.ts`, since `coreCheckRegistry()` lives
there and `aeg-core` cannot import it without closing a dependency cycle; the standalone
`packages/aeg-core/bin/verify-registry.ts` prints an explanatory note and skips it.

Also re-grades G1 (implementation-exists) from report-only to blocking: its report-only window had
already cleared the orphan backlog it existed to surface, and a permanent `info` finding on every run
had become indistinguishable from silence — precisely how the gap G6 closes stayed invisible for as
long as it did. G2 (no-orphan-hook/CLI) is unchanged, still report-only.
