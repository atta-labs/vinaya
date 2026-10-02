---
'@attalabs/vinaya': patch
---

A dispatched code-reviewer or security pass now judges a pull request without ever holding a `gh` command or a GitHub credential.

Before either role dispatches, the driver stages three files inside the round's shared, read-only candidate copy — the pull request's own body, the unified diff of the judged head against its base, and the prior round's held findings — written once, before either role's scratch copy is taken, so both roles read the identical, immutable bytes. Each dispatch's own prompt names the three files by their absolute path inside that attempt's scratch copy. The `code-reviewer`/`security` tool grant (`dispatch.ts`) now denies `gh` in full, rather than allowing `gh pr view`/`gh pr diff`/`gh issue view` — the three staged files replace what those reads used to give a dispatched reviewer, including the signal the security pass's `SECRETS:` line needs, which it now reads off the staged CI conclusion instead of `gh pr checks`. The dispatched case in `roles/reviewer.md`/`roles/security.md` is updated to match; a human running either role at their own terminal keeps using `gh` as before.
