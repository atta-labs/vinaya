---
'@attalabs/vinaya': patch
---

The post-merge Archivist treats a pull request as already carrying provenance only when a comment starts a line with the provenance heading, so a ruling that quotes the heading no longer makes it skip the post. A failure in CI's "Check the test inventory and run the repository suite" step is read as a code failure the Developer repairs, not an unclassified pause for the Operator.
