---
"@attalabs/aeg-core": patch
"@attalabs/vinaya": patch
---

`devReviewLoop` (`@attalabs/vinaya`) now tells a review dispatch that wrote nothing apart from one that wrote an empty, clean `findings.txt`: a work directory still missing `findings.txt`, `report.txt`, or (on a task with objectives) `objectives.txt` after a fresh dispatch is retried once into a fresh work directory, and a second miss pauses the loop through a new `'infrastructure'` pause reason (`@attalabs/aeg-core`) naming the role and the missing artifact — never held or published as a verdict. The reviewer/security dispatch prompt now names `objectives.txt` whenever the task carries objectives.
