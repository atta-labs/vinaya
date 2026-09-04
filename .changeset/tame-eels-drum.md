---
"@attalabs/vinaya": patch
---

`main-branch-refusal` now declares `VINAYA_PUSH_REFS` in its check env allowlist. Without it, `buildCheckEnv` stripped the variable before the check subprocess ever saw it, so a tag-only `git push origin --tags` from the default branch (e.g. `vinaya release`'s last step) still refused as if it were a plain commit — the fix in #409 (Issue #407, O2) wired the hook and the check's own logic to handle a tag-only push, but never added the env var to this check's registry entry.
