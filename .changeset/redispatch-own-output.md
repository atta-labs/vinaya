---
'@attalabs/vinaya': patch
---

A reviewer dispatched again in a round already reviewed now writes into its own fresh output directory, so the loop never reads an earlier dispatch's findings or report as the new verdict, and a file older than the dispatch counts as missing. Claude's sandbox now grants a reviewer's output directory to its commands as well as its file tools, matching Codex.
