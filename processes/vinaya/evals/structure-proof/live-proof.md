# The structure proof, live

The deterministic proof (`run-proof.ts`, beside this file) drives stub agents only. This procedure is its live half:
the Principal runs it once on Claude Code and once on Codex before a structural move, and records the observations
below for each agent. It runs against the disposable sandbox repository only, never this repository, and both
agents run by subscription login: no API key is set or used at any step.

In every command below, `$VINAYA` is this repository's own command-line entry, `bun <this checkout>/apps/cli/src/index.ts`,
run from a clone of the sandbox repository.

## Before every move: drain each host

On each host that runs loops (the Mac and the development server), from this repository's checkout:

```
cd processes/vinaya && bun evals/structure-proof/drain-check.ts
```

It reads the host's own runtime directory, never the forge, so a run whose Issue is already closed is still found. It
lists every task with a live driver lock, a pause state, or an Engine run whose checkpoint is not at a terminal step,
separates those live and resumable runs from completed history, and exits non-zero while any live or resumable run
exists. Record its full output for each host before the move. A host that exits non-zero is not drained: finish,
cancel or set aside each run it names, then run it again.

## The sandbox repository and trial isolation

- **Repository:** `atta-labs/vinaya-whole-loop-sandbox`, the disposable private sandbox the evaluation freeze record
  names (`wholeLoopSandboxRepository`, `apps/cli/tests/eval/freeze-record.json`).
- **Each agent's trial starts clean** (evaluation program, per-trial isolation): a fresh clone of the sandbox, a fresh
  vendor home signed in by subscription, a fresh runtime directory, and its own proof task Issue. No file, branch or
  checkpoint from the other agent's trial is reused.

## The frozen proof task

Open one backlog Issue per agent in the sandbox, with no `vinaya/tranche:*` label (`task run --issue` refuses a
tranche Issue), with this body. `docs/proof-source.md` must
**not** exist on the sandbox's default branch when the run starts.

```markdown
**Goal:** `greet(name)` returns the greeting `docs/proof-source.md` defines.
**Tier:** 1

## Objectives

O1. `src/greet.ts` exports `greet(name: string): string`, returning the greeting `docs/proof-source.md` defines for `name`.
O2. `src/greet.test.ts` asserts `greet('Ada')` returns that greeting.

## Documentation

- `docs/proof-source.md` — the greeting `greet` returns (O1, O2)

## Stop conditions

- `docs/proof-source.md` cannot be read.
```

Start it on the Engine runner:

```
$VINAYA task run --issue <n> --agent <claude|codex> --runner atta-engine
```

## The pause point

The missing-source pause: the run's source-preparation step cannot read `docs/proof-source.md` at the revision the
frozen brief records, refuses, and the run halts before the Developer is dispatched. It is the pause the deterministic
proof's first resume entry drives (`a refused step runs again on resume; a step that completed normally does not`).
The pause is raised before any pull request exists, so its comment, and the ruling that answers it, are on the task
Issue.

## Recovery, in order

Sources are read at the revision the newest frozen brief records, never at the sandbox's current default branch, so
adding the missing file alone does not clear the pause. Only rulings posted after the newest frozen brief count.

1. **Add the missing path.** Commit `docs/proof-source.md` (one line, for example `Hello, <name>.`) to the sandbox's
   default branch.
2. **Supersede the frozen brief**, which records the new revision:

   ```
   $VINAYA task brief --issue <n> --supersede --reason "docs/proof-source.md added on the default branch"
   ```

3. **Post the ruling** on the task Issue, after that brief: a comment whose first line is the ruling marker line the
   pause comment names (`aeg:principal:ruling:<ref>-<ordinal>`), with an ordinal greater than the one the pause was
   raised under, followed by the decision (resume).

The refused step was never recorded as completed, so the resumed run runs it again at the new revision, reads the
file, and continues to the Developer.

## The cancel

After the first run reaches its pull request, start a second run of the same task with the same `task run` command.
While its Developer is working (its launch line is in the driver log), stop it: send SIGTERM to the runner, or press
Ctrl-C in the terminal it runs in. A working Engine run is cancelled through its run control: the runner halts the
run, ends its agents, and exits. Then call the Operator's `task_cancel` for the task, after posting a ruling with a
newer ordinal on the task Issue. `task_cancel` consumes a paused escalation: when the stopped run left none, it
refuses with `has no paused run recorded — nothing to cancel`. Record its report or its refusal word for word.

## What the Principal records, per agent

Record each observation in the pull request, once for Claude Code and once for Codex.

1. **The run stops at the pause, with its reason and who must act.** The pause comment on the task Issue names the
   missing source as its reason and the Principal as the one who must act, with the ruling marker line and ordinal to
   use.
2. **Status reports it paused.** `$VINAYA task status --json` shows the task paused at that pause.
3. **The posted ruling resumes it by itself.** After the three recovery steps, the halted runner picks the ruling up
   without another command, runs the refused step again at the new revision, and continues.
4. **Cancel reports its effects as confirmed, pending or uncertain.** The second run's agents end when it is stopped,
   and `task_cancel` reports its effects as `confirmed`, `pending` or `uncertain`, or refuses as above; record which.

## The packed leg

```
cd processes/vinaya && bun evals/structure-proof/run-proof.ts --packed
```

After the listed tests, this runs the shipped-command lifecycle (`apps/cli/scripts/verify-published-lifecycle.ts
--local-pack`) against an `npm pack` of this working tree, installed outside the repository. Before the version it
packs is published, exactly one row is expected to fail: **`demo break`**. Its generated hooks pin
`npx --yes @attalabs/vinaya@<version>`, which the registry does not have yet, so the hook refuses both commits. Any
other red row is a real failure.
