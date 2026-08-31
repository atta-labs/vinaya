---
"@attalabs/vinaya": patch
---

`pr verify-evidence` — security review follow-ups, including one false-MATCH
path introduced by a previous round's own fix.

The cross-machine path normalisation matched any INTERIOR path segment sitting
before a known directory name, not only a checkout root. Two genuinely different
in-repo files collapsed onto one line — `packages/sources/tests/a.spec.ts` and
`packages/aeg-core/tests/a.spec.ts` both became `packagestests/a.spec.ts` — and a
body containing both compared MATCH. That is precisely the false-MATCH class this
command refuses a dirty worktree to prevent, and it was reachable from
pull-request text alone. The match is now anchored to an absolute path at a token
boundary, and `tests` is out of the directory list because it is not a top-level
entry of this repository.

Control-character stripping now covers what a C0-only pass left behind: C1
(including U+009B, an alternate escape introducer), the Unicode line terminators
U+0085 / U+2028 / U+2029, and the bidi overrides U+202A–U+202E / U+2066–U+2069.
All of them reached a terminal or an ANSI-rendering CI log through the rendered
verdict.

`BASE_SHA` is refused rather than honoured. The regeneration resolves its
merge-base from that variable, so an override changes what "a fresh run" means —
the same contamination class as a dirty worktree, and refused for the same
reason.

Head binding now fails closed: an absent `headRefOid` refuses instead of
silently skipping the check, which had left the verdict bound to no commit.

`publishedMergeBase` is linear on whitespace — with `\s*` under the `m` flag its
leading and trailing quantifiers overlapped across lines and went quadratic,
measured at 3.5s on a 65 KB body, over attacker-authored text, twice per run.

`renderVerdict` no longer asserts "the merge-base is unchanged" when neither side
carried a readable Group A line to compare.
