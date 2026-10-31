---
"@attalabs/vinaya": minor
"@attalabs/vinaya-sources": patch
---

A self-hosting repository's version-2 publication can owe its required CI check whether its selected tests ran locally or were deferred: `prePush.requiredCi` on the default branch names the check, and an existing `prePush.readyTests` opt-in still supplies the same pair when the new key is absent. A locally tested head keeps its real test command in the Test Plan and Evidence, and the run completes only once the strict required-CI read succeeds on its current head; a driver with no strict reader pauses instead of falling back to the generic check read. In a repository that commits a native local-run adapter, the generated pre-push hook hands every test-running push to it, and the Test Plan line and Evidence of such a run come only from its own receipt at the same head, tree and verification context: a missing or unqualified receipt reads as not run, never as a pass.
