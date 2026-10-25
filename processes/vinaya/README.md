# processes/vinaya

The Vinaya process: its roles, Flows, gates and evaluations. Belongs to the "Any Process, One Harness" project.

The Engine runner stamps its Log events with the loaded process identity
(id, version and loader digest) and runner `atta-engine`. The runner version
comes from the installed `@atta/engine` package's own `package.json`.
It sets the producer identity environment before creating its Log sink;
the header's runtime retains its existing meaning.

A pull request that changes how the process works must raise `version` in
`process.yaml` to a higher semantic version. The files that count are
`process.yaml` itself (any change other than its `version` line), the flow
file it names under `flow`, the `doctrine.md`, `grants.yaml` and
`output.schema.json` of every role folder it names under `roles`, and
`executing/actions.ts`, the action and decision bindings. The registered
check `atta-labs/process-version-bump` enforces this on pull requests that
change files in this folder: it passes and says it skipped when no governed
file changed, and it treats any state it cannot decide, such as a missing or
non-semantic version, as an error rather than a pass.
