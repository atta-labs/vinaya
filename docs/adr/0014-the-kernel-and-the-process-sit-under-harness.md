# 0014. The kernel and the process sit under harness

**Status:** Accepted

**Date:** 2026-10-31

## Context

Record [0012](0012-harness-and-processes-sit-at-the-repository-root.md) put the generic machinery in a root `harness/` folder and each process in a root `processes/` folder, and left `apps/` and `packages/` in place until each piece was retired. Since then the generic machinery and the Vinaya process have both grown, and most of the code that runs the developer-review loop still sits in `apps/cli/src`, `packages/aeg-core` and `packages/aeg-forge-state`, where generic code and Vinaya-only code are mixed. A reader cannot tell from a path whether a file is generic or belongs to the process, and the one import test that exists only checks files already under `harness/`.

The code that will move is large, and it will move in many separate changes. Each change needs a fixed destination, a rule that decides where a given file goes, and a measure that shows the mixing going down and never up.

## Decision

We will hold all generic machinery and every process under one `harness/` folder: a kernel at `harness/kernel/` that never names a process or a role, and each process at `harness/processes/<name>/`. The Vinaya process, today at `processes/vinaya/`, becomes `harness/processes/vinaya-strict/`. Every later move lands in this tree:

```
harness/
  kernel/                      generic; never names a process or a role
    config/{schema,loader}
    dev-process-socket/{contract,loader}
    loops/
      runtimes/{atta-engine,standalone}
      batch/                   planned, empty
    handlers/                  planned, empty
    connectors/{agent-launch,filesystem,git,forge,sandbox,log,checkpoint}
    adapters/
      agents/{claude-code,codex}
      reviewers/
      code-host/github/
      tracker/{github-issues,linear,file}
    tools/{host,catalog,run,change,pull-request,sources,batch,evidence,human-decision}
    gates/{checks,ring0-hooks,ring1-ci,ring2-audits}
    log/{schema,client}
    telemetry/
    improver/                  planned
    isolation/
    effects/
    evals/
    conformance/{unit,live-matrix}
  processes/
    vinaya-strict/             today's processes/vinaya, renamed
      process.yaml
      integration/
      loops/dev-review/        the flow, its actions, its seats and the process's own drivers
      tools/{task-contract,plan,pr-report}
      thinking/{architect,planner}
      executing/{operator,developer,code-reviewer,security-reviewer}
      retrospecting/{archivist,tranche-archivist}
      artifacts/
      checks/
      evals/
apps/
  cli/                         commands only
  log-server/
  vinaya-portal/
packages/
  sources/
  typescript-config/
  the published packages, under their names, until separately scoped work retires them
```

`harness/kernel/loops/runtimes/standalone/` stays empty until a generic runtime that knows no process is extracted, which is separate work.

These rules decide where a file goes:

- The kernel never names a process or a role.
- A driver that imports the process's round assessment, chooses its reviewers or interprets its stops belongs to the process, whichever runtime runs it.
- A tool's code lives by what it knows: generic code under the kernel's `tools/`, Vinaya-only code under the process's `tools/`.
- The check runner, its registry and its rings are the kernel's; which checks run is the process's.
- Tracker and code-host adapters are the kernel's; how a task writes its dependency and conflict edges is the process's.
- Tests that prove a kernel guarantee live under the kernel, tests of Vinaya policy live under the process, and a test that loads both is an integration test that lives with the process.
- A published package keeps its name, its exports and its installed behaviour, and anything it re-exports ships inside its own tarball or through a declared dependency.
- The moves change no behaviour and build no planned folder.

A counted ratchet measures the mixing. In every non-test source file of the code that is not a process, it counts each process name, each role name and each import of a process or of a package this tree retires, and compares each file's count with a committed baseline that may only shrink, checked against the pull request's base on every pull request.

## Considered options

- Keep the two root folders of the superseded record. The kernel and the process stay siblings at the root, but the mixed code in `apps/` and `packages/` has no fixed destination, and nothing measures whether a change reduces the mixing.
- Move everything in one change. The final shape arrives at once, but the change is too large to review, and a behaviour change hidden in a move cannot be told apart from the move itself.
- Fix the destination tree and its placement rules now, and move piece by piece under a counted ratchet. This is the chosen option: each move is small and behaviour-neutral, the destination of every file is decided by a rule rather than by the change that moves it, and the ratchet shows the count only going down.

## Consequences

Every later move has a fixed destination and a rule that decides it, so two changes cannot place the same kind of code in two homes. The ratchet makes each move prove it added no process or role name to the kernel's side, and a change that lowers a count lowers the baseline in the same change. A relocated import or path string keeps its count rather than reading as growth, and an old path kept as a pure forwarding entry hands its count to its new owner. Until the moves are done, the counted names remain in the baseline, and the repository holds code in both the old and the new places. The root `README.md` layout tree changes with the moves that change the layout, not with this record.

## Where it is applied

`harness/tests/architecture-ratchet.ts` holds the token list, the matching rule, the scope walk, the baseline writer and the base comparison; `harness/tests/architecture-baseline.json` is the committed baseline and `harness/tests/ownership-map.json` the committed ownership map. `harness/tests/architecture.test.ts` keeps the import checks and compares the counts with the baseline. The build job of `.github/workflows/ci.yml` runs the ratchet test and the base comparison on every pull request.
