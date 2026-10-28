# processes/vinaya

The Vinaya process: its roles, Flows, gates and evaluations. Belongs to the "Any Process, One Harness" project.

The Engine runner stamps its Log events with the loaded process identity
(id, version and loader digest) and runner `atta-engine`. The runner version
comes from the installed `@atta/engine` package's own `package.json`.
It sets the producer identity environment before creating its Log sink;
the header's runtime retains its existing meaning. It also stamps which flow
ran: `flow.id` is the chosen Flow file's own `id` and `flow.version` the flow
key the run chose (`v1`, `v2`), so the two flows are compared from the Log.

The process declares its flows under `flows` in `process.yaml`, by key, with
`default_flow: v1`. A run chooses one with `vinaya task run --flow <key>`
(Atta Engine runner only; the standalone runner runs v1) and records it in
`<runtimeDir>/engine-runs/<task>/flow.json`, so a resume continues the same
flow and refuses a different one.

The v2 flow reads an open pull request's mergeability in its reconcile step: a
conflicting one is recorded and sent to the Developer as its first turn, and
its `prove-conflict-repair` step proves the Developer's merge (a published
merge commit including the fetched default-branch tip, no unresolved index
entry, a clean merge with the default branch fetched again, a `MERGEABLE`
pull request) before any local check or reviewer judges it
(`apps/cli/specs/loop.md`, "Version 2: a conflict re-entry starts with the
Developer").

A pull request that changes how the process works must raise `version` in
`process.yaml` to a higher semantic version. The files that count are
`process.yaml` itself (any change other than its `version` line), the flow
file it names under `flow` (or every flow file it names under `flows`), the `doctrine.md`, `grants.yaml` and
`output.schema.json` of every role folder it names under `roles`, and
`executing/actions.ts`, the action and decision bindings. The registered
check `atta-labs/process-version-bump` enforces this on pull requests that
change files in this folder: it passes and says it skipped when no governed
file changed, and it treats any state it cannot decide, such as a missing or
non-semantic version, as an error rather than a pass.
