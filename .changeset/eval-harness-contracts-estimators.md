---
'@attalabs/vinaya': patch
---

The evaluation harness gains typed task, trial, grader, suite and report contracts with validators that refuse malformed values with a typed reason, and pure estimators — per-task tallies, pass^k, the per-suite mean with a seeded bootstrap interval, paired regressions and quarantine counts — that take their method, seed and resample count as explicit inputs. The harness is internal: an architecture test keeps it out of the shipped CLI.
