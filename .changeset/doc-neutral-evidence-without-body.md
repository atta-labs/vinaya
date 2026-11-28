---
"@attalabs/vinaya": patch
---

The doc-coverage checks now let a comment- or whitespace-only change to a doc-bound file through in a run given no pull request body, such as the commit hook and the push hook, on the diff evidence alone, with a note that the `Doc-neutral:` line is owed in the pull request body. A run given a body, an empty one included, still requires the declaration and the evidence together, so the pull request's CI run refuses the change until the body declares it.
