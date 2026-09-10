---
"@attalabs/vinaya": patch
---

`devReviewLoop`'s mechanical gate now excludes the review gate's own check-run by name, so a head with green CI and no verdicts yet reads green, never red. A red-gate developer dispatch now waits for the branch head to change before reading the gate again, naming the failing check-run(s) in the developer's prompt; a bounded number of consecutive turns that push nothing on one head now ends in `pause{reason:'infrastructure'}` instead of unbounded re-dispatch. The reviewer-infrastructure pause (added previously) now logs the same `stop_condition_met`/`paused`/`round_ended`/`journal_finalized` events every other pause reason gets, instead of skipping the log entirely. When the loop starts for a task whose developer branch already has an open pull request, it attaches — no new developer is started — and resumes the recorded developer session when later rounds need one; a remote branch with no open pull request resumes that session once to open it.
