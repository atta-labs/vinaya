---
"@attalabs/vinaya": patch
"@attalabs/vinaya-sources": patch
---

Every file a task's run writes now lives under one configured directory, laid out by task and by round. A new `runtimeDir` setting in `vinaya.config.json` names it; absent — the default for every repository that has never set it — runs write under `~/.vinaya/runtime/<owner>-<repo>`, keeping the repository segment because task numbers repeat across repositories.

The layout is `<runtimeDir>/tasks-execution/<task>/`, with the task's files classified by nature rather than by which module happened to write them: `control/` for the control-store records (ownership, transitions, loop state, effects, resolutions, escalations, review-input manifests and the pause state), `sessions/` for vendor session ids, `hooks/` for the per-run documentation-check files, `output/` for raw agent output and the driver's own log, `rounds/<n>/` for that round's reviewer and security hand-off files with its read-only candidate and per-role scratch copies, and the driver lock at the task folder's root. Twenty-four modules each built their own path before this; they all resolve through one function now, and an architecture test fails the build if any other file assembles one.

The two control-store roots that disagreed about where a task's records lived are one root. No record's filename, content or version changed — only which directory holds it.

**`runtimeDir` is repo-local and absolute.** It is read from a repository's own `vinaya.config.json` only — set in the machine-global `~/.vinaya/config.json` it is ignored with a warning, the same as `checks`, `roles`, `principals`, `releaseActor` and `tokens`. Only the DEFAULT carries the `<owner>-<repo>` segment, so a machine-wide value would collapse every repository on the host into one tree and hand two repositories' identically-numbered tasks the same driver lock, the same ownership epochs and the same session record. A relative path is refused (each process would resolve it against its own working directory), and so is one naming a directory inside the repository. Every directory under it is created owner-only.

**Behavior change, and what it needs from you.** Nothing reads, moves or migrates the folders earlier runs left behind under `~/.vinaya/` (`dispatch-output/`, `dispatch-resume/`, `dispatch-settings/`, `loops/`, `control-store/`, and the driver files that sat inside `outbox/dev-review-loop/`): a run in flight when this lands must finish, or be cancelled, before upgrading, and the old folders are yours to delete once no run depends on them. `runtimeDir` is honoured from the repository's DEFAULT BRANCH only for an unattended caller — the same rule `logPublish.webhookUrl` already carries — so a pull request under review cannot redirect the driver's own lock, control records or held verdicts into a tree its own agent is allowed to write.

The telemetry outbox is deliberately unchanged and still lives under the Vinaya home; where log events are delivered is changing separately, and moving the outbox now would mean moving it twice.

The worker sandbox's exact-file grants follow the new layout and are now absolute paths rather than subpaths of a single root, since a configured `runtimeDir` and the telemetry outbox can sit under different roots. A confined role is granted its own task's session record and its own round's work directory and nothing else — the scope that used to be part of a filename in one shared per-repository directory is the folder now, so a sibling task's records are in a directory the sandbox profile never mentions.
