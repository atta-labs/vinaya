---
"@attalabs/vinaya": patch
---

`vinaya init`/`vinaya doctor` now recommend protecting `.github/workflows/**` with a `CODEOWNERS` entry, alongside the existing branch-protection recommendation — printed guidance only, never applied and never a suggested identity. `vinaya-review.yml`'s `pull_request_target` boundary loads workflow files from the default branch specifically so a PR cannot rewrite the check that judges it; an unreviewed edit to that file on the default branch itself defeats the same boundary from the other side. `doctor` gained a matching diagnostic reporting whether `.github/CODEOWNERS` covers `.github/workflows/**`.
