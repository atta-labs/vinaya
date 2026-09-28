---
'@attalabs/vinaya': patch
'@attalabs/vinaya-sources': patch
---

A `vinaya` process started with a `PATH` that does not contain the GitHub CLI's install folder — as the Claude desktop app starts an Operator's task tools on macOS, whose `PATH` lacks `/opt/homebrew/bin` — now still runs `gh`. At process start, before any command runs, the CLI appends a standard `gh` install location (`/opt/homebrew/bin`, `/usr/local/bin`) to its own `PATH` when `gh` is not already reachable and that folder holds an executable `gh`; every child process it spawns inherits the amended `PATH`, so all 23 `gh`-by-name call sites — including the unattended trust-anchor read that decides where a run's telemetry is delivered — resolve it. A `PATH` that already finds `gh` is left unchanged, and existing entries are never reordered or removed.

`vinaya doctor` gains a `[gh]` finding: when `gh` is at none of those locations and not on `PATH`, it reports that `gh` is missing and names the standard locations it searched.
