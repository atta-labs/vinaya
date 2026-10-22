# harness/gates

Gates any process can use to hold a transition. Belongs to the "Any Process, One Harness" project.

- `run-checks.ts`: `runCli` runs a CLI entry the caller names, under the runner's own runtime, in a given directory. `runCliChecks` runs that entry's `check --all` and passes on exit 0.
- `guarded-spawn.ts`: `guardedSpawnSync` starts a runner command in its own process group through a watcher process. If the runner dies, the watcher ends that group: SIGTERM first, then SIGKILL after a grace period.
