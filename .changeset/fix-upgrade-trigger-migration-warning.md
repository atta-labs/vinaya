---
"@attalabs/vinaya": patch
---

`vinaya upgrade` now warns when a regenerated `.github/workflows/*.yml` file's trigger type is about to change (e.g. `pull_request` → `pull_request_target`), before the adopter pushes. GitHub evaluates a `pull_request`-triggered workflow from the PR branch's own file and a `pull_request_target`-triggered one from the base branch's file — a PR that crosses that boundary matches neither, so the resulting PR's required `vinaya review gate` check can never report, permanently blocking merge on a repo that enforces it as required. The warning is print-only guidance, same as the existing branch-protection and CODEOWNERS recommendations — `upgrade` still applies the change; only the adopter's blindness to its consequence was the bug.
