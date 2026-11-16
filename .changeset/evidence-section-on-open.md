---
'@attalabs/vinaya': patch
---

The Developer's `open_pull_request` and `update_pull_request_body` tools add the `## Evidence` section with its anchor pair when the body has none, so the loop can always write the run's evidence into the pull request.
