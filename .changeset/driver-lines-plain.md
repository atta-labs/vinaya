---
'@attalabs/vinaya': patch
---

The loop's own lines now read as rounds, verdicts, confidence and who must act. The log and the terminal mark a round starting with its role and model, the reviewers starting, each reviewer's verdict with its blocking count, and a round ending with its duration, its confidence and its outcome. A pause or stop that needs a person says what has to be decided and that the run continues through the Operator's `task_resume`. The start-of-run sweep is one summary line instead of one line per folder, and a relaunch writes one "Resumed" line.
