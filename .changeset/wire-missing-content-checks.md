---
"@attalabs/vinaya": minor
---

`vinaya issue create`/`vinaya issue edit` now run the three Issue-only content checks `packages/aeg-core/bin/open-issue.ts` has always gated task Issues on — `checkBlastRadiusScope`, `checkNoBriefContent`, `checkRationaleNamesDocs` — which had never been wired into the published CLI's own reimplementation of that validation path. Every adopter using `@attalabs/vinaya` (not only this repo) previously had only the 14 section-presence checks enforced on `issue create`/`edit`; a task Issue could carry a fully-formed but factually wrong rationale (an under-declared blast radius, brief-shaped content copied into the Issue, a rationale naming no doc it actually read) and pass. These three now run, unconditionally, immediately after the existing rationale-presence gate, for any Issue carrying a `vinaya/tranche:*` label.
