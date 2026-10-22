# processes/vinaya/executing

The roles that do and check the work. Belongs to the "Any Process, One Harness" project.

`actions.ts` binds the Flow's mechanical steps to the review loop's functions. The assess-round step reports `{decision, events}` as JSON in its result, so the Log events the assessment produced travel with the step.

`log-events.ts` supplies the Log producers for the harness translator in `harness/dev-process/logging`: a heartbeat at each node start, an attempt record when an agent step completes or fails, the assessment's own events when assess-round completes or pauses, and the pause, resume, cancel and exit records at the edges of a leg.

`log-inventory.ts` is the inventory table. It holds one row for each event the review loop's driver wrote (its fifteen loop events, the handoff events and the role attempt): produced by a producer, dropped with a reason, or deferred with the reason it is not produced yet. `tests/log-events.test.ts` is the coverage test: it fails when an event name in the loop schema or the role-attempt schema has no row, when the dropped rows are not exactly `unpushed_work_resume` and `infrastructure_retry`, when the deferred rows are not exactly the handoff events, or when a produced row names an event no producer wrote in the test's runs. The same file runs the Flow on stubs and checks the exact event sequence of a green run, a revision loop-back, a halt then resume and an exhausted revision ceiling, with every event parsed against its family's schema.

`developer-prompt.ts` builds the Developer's prompt exactly as the standalone review loop's `dispatchDeveloper` does, using the same builders.
- **First turn:** required sources, the developer doctrine block, the publishing line, the Issue's rulings after the brief, the kept-work note, the turn-result instruction, the full context packet, then the frozen brief.
- **Later turns:** required sources, the delta context packet naming the continued session, the resume context (Issue, branch, worktree, remote head), the previous round's held review findings with their ids (or the failing `check --all` output after a red gate), the publish-the-fix line, then the turn-result instruction.
- **Session:** the runner continues the Developer's own vendor session across turns (`continueSessions: ['develop']`): `claude -p --resume <id>`, `codex exec resume <id>`.
- **Tests:** `tests/developer-prompt.test.ts` compares both prompts with the loop's for the same inputs; `tests/developer-session.test.ts` checks that turn 2 launches with turn 1's session id on both vendors.
