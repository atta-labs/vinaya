---
"@attalabs/aeg-core": minor
"@attalabs/vinaya": minor
"@attalabs/vinaya-sources": patch
---

A task Issue body now carries four more sections under the Planner's rationale — `## Surface` (directory-level `in:`/`out:` glob lists), `## Parts` (numbered `Part <k> (O<n>[, O<m>]) — <outcome>` lines), `## Test plan` (the `unit-tests-only` sentinel or a fenced command list), and `## Stop conditions` (a bullet list) — each parsed by its own function in `@attalabs/aeg-core` (`parseIssueSurface`, `parseIssueParts`, `parseIssueTestPlan`, `parseIssueStopConditions`), and composed into one gate, `checkIssueBriefSections`. A task Issue numbered at or above `BRIEF_SECTIONS_SINCE_ISSUE` is refused, naming the missing/malformed section, when any of the four is absent; below the cutover an Issue passes unconditionally, and a null Issue number fails closed.

`vinaya brief render` now fills a rendered brief's §4 Out of surface, §6 Numbered parts, §9 Test Plan, and §10 Stop conditions directly from these four parsed sections instead of a hand-authored placeholder, and refuses — naming the section — when one cannot be derived. A rendered brief needs no hand edit to pass `verify-brief`/`brief-shape`.
