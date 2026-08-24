---
"@attalabs/vinaya": patch
"@attalabs/aeg-core": patch
---

`vinaya pr create`, `vinaya pr edit`, and `open-pr.ts` now run the `body-bare-digits` check before
any forge write, instead of only in CI after the pull request already exists.

`body-bare-digits` is one of four checks marked `requiresOpenPr` — the other three (`closes-n`,
`test-plan`, `evidence-fresh`) genuinely need a PR number or PR comments and cannot run earlier. This
one is a pure function of body text with no such excuse: a bare digit outside a fenced code block or
an `AEG:*` anchor was always knowable before the write, and the gate ran anyway only in
`pull_request_target` CI, after the body had already reached GitHub. Two of the four workflows re-fire
on a body edit, so a check that could have refused locally instead cost a live CI run and a second
edit to fix.

`gatePlanForBranch` in `open-pr.ts` now includes `body-bare-digits` in the base plan for every branch,
not only task branches — the check itself, not a branch condition, exempts
`changeset-release/main`. `vinaya pr create` and `vinaya pr edit` refuse with the same
`CheckError` shape either command already uses for `validateForgeWrite` failures, before the `gh`
call.

No behavior change to what counts as a violation — `checkBareDigits` itself is unchanged. The
`tests/fixtures/forge/pr-valid.md` fixture, which predates this gate, carried a bare version number
and a bare `Closes #385`; both are now backticked/anchored so the fixture still represents a body that
should pass.
