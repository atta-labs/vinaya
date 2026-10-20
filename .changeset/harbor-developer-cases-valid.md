---
'@attalabs/vinaya': patch
---

Every containerizable developer case now passes with its reference solution in its Harbor task image. The image links `claude` in `/opt/claude/bin`, first on `PATH`, installs `gh`, fetches the base commit with its full history and no blob, and ends as the non-root user `tester`, which the `vinaya` agent's run works as; reference-solution files keep their git file mode. The verifier runs each hidden test file in a runner of its own and hands no runner a non-test file, and the hidden-tests grader accepts a skipped pass-to-pass test. A committed quarantine record keeps three developer cases' task folders while the Harbor results reader counts their trials apart, under the run's new `quarantined` list.
