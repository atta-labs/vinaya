---
"@attalabs/vinaya": patch
---

Adds `pr-report-density`, a new check enforcing a rule the doctrine already states (`aeg-root/roles/developer.md` § PR body — canonical form: Summary and Scope are each exactly one paragraph) but nothing mechanically verified — confirmed live, three real PRs shipped multi-paragraph Summary/Scope sections with nothing catching it, at `vinaya pr create`/`pr edit` time or in CI. Matches `brief-shape`'s registration (no `requiresOpenPr`, so it also runs against a draft body before the PR exists: `PR_BODY="$(cat draft.md)" vinaya check pr-report-density`), and reuses `anchored-region.ts`'s existing anchor-bounds helper so an anchored field (Scope's trailing `AEG:TIER` block) is never miscounted as a second paragraph.
