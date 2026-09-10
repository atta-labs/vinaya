# The dev-review-loop — command, rounds, exits, publication and pause

Status: draft

`vinaya dev-review-loop --task <n> --agent <claude|codex|gemini>` (`apps/cli/src/commands/dev-review-loop.ts`, `devReviewLoopCommand`) runs the developer/reviewer round loop for one task Issue, unattended, until it publishes or pauses. The full design is the Linear "Tech spec — Developer Review Loop" (rev 4); this file is the durable, in-repo reference for what shipped across `dev-review-loop-v1` tasks 4–6 — the state machine, the driver, publication and pause — not a restatement of the whole spec.

`packages/aeg-core/src/dev-review-loop/` is the policy layer: `assessRound` (task 4, `#414`) is the ENTIRE decision logic — every stop condition, every confidence rule, the `Decision` a round produces — as one pure function, no `fs`/`fetch`/`process.env`/subprocess/prompt anywhere in that directory. `apps/cli/src/lib/dev-review-loop.ts` (`devReviewLoop`, tasks 5–6) is the driver: it turns real forge/dispatch facts into `Observations`, calls `assessRound`, and acts on the `Decision` it returns. It never re-implements a stop condition or a confidence rule.

## The command

```
vinaya dev-review-loop --task <n> --agent claude|codex|gemini [--json]
vinaya dev-review-loop --resume <pr> --agent claude|codex|gemini [--json]
```

`--task <n>` starts a fresh loop against task Issue `<n>` — `n` is a GitHub Issue number, not a tranche task ordinal. `--resume <pr>` continues a previously paused loop from its held state (see "Pause and `--resume`" below); it takes a pull-request number, since a paused loop is anchored to an already-open PR, not an Issue. `--agent` falls back to `dispatch.agent` in `vinaya.config.json` when omitted. Both forms build the same `LoopInput` union and make exactly one call into `devReviewLoop` — `apps/cli/specs/surface.md`'s one-command-one-effects-call rule.

## Rounds

Round 1 dispatches the developer fresh, brief read verbatim from the task Issue's frozen `aeg:brief:v1` comment, then waits for the PR it opens. Every round after that:

1. **Gate.** `resolveHead`/`fetchCiConclusion` read the branch's live head and CI conclusion — never run locally (Traps: the mechanical gate is the CI system's own verdict, not a local re-run). Red sends the developer back for the same round. Green and round 1 goes straight to reviewers; green from round 2 on gates on developer confidence first (below).
2. **Reviewers.** Both roles are dispatched fresh every round (`dispatchRole` called anew — a reviewer session is never resumed; only the developer's is). Each reads facts-only (`renderReviewerPrompt`: objectives, Principal rulings, head, CI conclusion — never developer- or PR-body-authored prose, `lintReviewerPrompt` enforces this) and writes `findings.txt`/`report.txt` to a driver-chosen work directory, plus `objectives.txt` whenever the task carries objectives (the prompt names the file only then; a task with no `## Objectives` section never asks for it). `buildVerdictFromReport` derives the verdict from findings (never hand-typed) and renders the same `VERDICT:`/`Judged head:` shape `review-post.ts` uses elsewhere; `writeHeldVerdict` holds it in the outbox — nothing is posted to the forge before green (Section 10 stop condition, tasks 4–5). A work directory still missing `findings.txt`/`report.txt` (or `objectives.txt` on a task that carries objectives) after the dispatch is an infrastructure outcome, never a clean verdict — an empty `findings.txt` is still clean, exactly as the reviewer contract promises (`review-validity-v1` task 1, `#475`, O1); see "Infrastructure failures," below.
3. **Verdicts.** `assessRound` combines both verdicts. Clean (both APPROVE/PASS, every objective MET) → `publish`. An `ESCALATE` from either role → `pause{reason:'escalation'}`, immediately, before any verdict is ever held or posted. Otherwise the findings are relayed to the developer for another round.

Round numbering: `round` advances only when a genuine review round concludes `changes_requested` and hands back another developer dispatch. A mechanical-gate-red retry and the confidence rule's one-extra-turn both resubmit the same round number — advancing on every developer dispatch would make a CI hiccup on round 1 silently trigger the round-1-never-asks confidence question.

## The confidence rule

Round 1 never asks for confidence. From round 2 on, a green gate reads `.vinaya-confidence` (written by the developer per `CONFIDENCE_PROMPT_LINE`'s instruction) before reviewers are ever dispatched:

- absent, asked once already → `pause{reason:'confidence'}`; absent, first time → re-ask once.
- below 50, one extra turn not yet spent → one more developer turn (spent once, ever), no reviewer dispatch; below 50 again → `pause{reason:'confidence'}`.
- 50 or over → dispatch reviewers.

## The four exits

`assessRound` decides every exit — the driver never re-derives one:

| Exit | Trigger | `Decision` |
| --- | --- | --- |
| green | both verdicts clean, every objective MET | `publish` |
| stalled | a fingerprint resolved earlier reappears (`reappearance`); two consecutive rounds resolve nothing (`no_progress`) | `pause` |
| capped | round count exceeds `MAX_ROUNDS` (3) | `pause{reason:'max_rounds'}` |
| escalated | either reviewer returns `ESCALATE` | `pause{reason:'escalation'}` |

The confidence rule's own collapse (`pause{reason:'confidence'}`) is a fifth practical pause path layered on top of "stalled," gating whether a round even reaches a verdict.

### Infrastructure failures (O1/O2, `review-validity-v1` task 1, `#475`)

A sixth pause path, decided by the driver itself rather than `assessRound` — the one exit the policy never sees, because it means there is no verdict to hand it. A review role's dispatch is retried once, into a genuinely fresh work directory (never the failed attempt's own), if its directory is still missing a required artifact after the first attempt; a second miss on the same role short-circuits straight to `pause{reason:'infrastructure'}` without ever calling `assessRound` for that round — no verdict is held, none is published, and the round number does not advance (the same way a mechanical-gate-red retry never advances it). The pause comment names the failing role and the missing artifact(s) it observed.

## Publication (O1, task 6)

At `publish`, `publishRound` (`apps/cli/src/lib/dev-review-loop.ts`) posts, through this repo's `gh pr comment` forge-write mechanics, in order: the round's held reviewer verdict, the held security verdict, then one summary comment from `renderSummary` (`@attalabs/aeg-core`) built from the loop's own round records. Each verdict post is re-read straight back off the PR and re-parsed through `extractCodeReviewVerdict`/`extractSecurityReviewVerdict` — the SAME extractors the merge gate itself calls — and refused (thrown) if it does not resolve cleanly to the round's judged head. The summary is checked BEFORE it is posted: both extractors run over the rendered text, and a summary that resolves as a real verdict through either one is refused rather than posted (`renderSummary`'s own contract is no `VERDICT:`/`Judged head:`/`Objectives version:` line; this is re-verified live rather than trusted).

Idempotency: each of the three posts is wrapped in `postForgeEffectOnce`, which records an effect id in the outbox as `started` before the `gh` call and rewrites it `posted` (with the returned URL) right after — mirroring `dispatch.ts`'s own effect-id-before/checked-after discipline, adapted to a comment post since `DevReviewLoopEvent` carries no `effect_id` field of its own. A rerun that finds an already-`posted` record for a given post returns its recorded URL without calling `gh` again — nothing is posted twice.

Supersession (editing a posted verdict, or marking one superseded after a later push) is out of `dev-review-loop-v1`'s scope: nothing is ever posted before green, so there is nothing to supersede in v1.

## Pause and `--resume` (O2, task 6)

At `pause{reason}`, the driver writes the round's held state (task, round, judged head, branch, PR number, reason, and — for `'infrastructure'` only — the role/artifact detail) to the outbox, then posts one comment on the PR marked `<!-- aeg:loop:paused:<reason> -->`, carrying the reason (plus that same detail, for `'infrastructure'`) and the exact resume command (`vinaya dev-review-loop --resume <pr>`, the real PR number substituted in). The pause comment carries no verdict grammar. The CLI command exits non-zero — the process-level signal an unattended dispatcher watches for.

`--resume <pr>`:

1. Reads the PR's body for its `Closes #N` reference to find the task.
2. Reads that task's held pause state from the outbox; refuses if none exists.
3. Requires a Principal-authored ruling comment on the PR (`fetchRulings`, non-empty) — refuses if none exists yet.
4. Re-resolves the PR branch's live head and compares it to the held state's recorded head. A mismatch refuses, naming the round to restart from — resume never silently restarts from round 1.
5. Re-enters the round loop at the held round, dispatching the developer fresh (a paused process's vendor session id is not durable across a restart — `DispatchOutcome` never persists one) with the Principal's ruling text as context instead of reviewer findings.

**v1 accepted loss:** resume re-enters with a fresh `LoopState` at the held round number — the round number itself governs the confidence rule's round ≥ 2 branching correctly, but the fingerprint/finding-identity memory (`lastIds`, `previousResolvedEmpty`) a full crash-recoverable journal would carry across the pause boundary does not persist. A stall trigger that depends on cross-round finding identity (reappearance, no-progress) resets at a resume. No infrastructure exists yet to serialize `LoopState`'s `Map`-typed fields across a process restart; building it is out of this task's boundary.

## Doc-owners binding

`.vinaya/doc-owners` binds `apps/cli/src/lib/dev-review-loop.ts` to this file — a code change to the driver requires this file to appear in the same diff (or a `Doc-ack`/waiver), per `verify-docs` C5.
