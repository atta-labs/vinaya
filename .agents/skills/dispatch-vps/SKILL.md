---
name: dispatch-vps
description: Run one Vinaya task's review loop on the development VPS — preflight, launch as a user systemd unit, watch, and recover.
---
# Dispatch a task to the development VPS

The VPS is the 4 GB Linux box where review loops run for development. Every
command below runs on the box as the `dev` user. `<vps>` is the box's host,
`<checkout>` the repository checkout on it, `<tranche>` and `<n>` the task's
tranche slug and number, `<issue>` its Issue number.

## 1. Preflight

Connect as `dev` and run every command through `bash -ic`, so the shell
profile loads — it carries `PATH`, the Claude login and `VINAYA_LOG_TOKEN`.
A plain `ssh <vps> '<command>'` skips the profile.

```bash
ssh dev@<vps> "bash -ic 'cd <checkout> && git status --short && systemctl --user list-units \"vinaya-task-*\" --no-pager'"
```

The tree must be clean. Count the `vinaya-task-*` units already running: the
box runs at most two loops at once, so a third waits until one ends.

## 2. Update and build

Fast-forward the checkout to the default branch, install, and build the CLI:

```bash
ssh dev@<vps> "bash -ic 'cd <checkout> && git checkout main && git pull --ff-only && bun install --frozen-lockfile && (cd apps/cli && bun run build)'"
```

## 3. Launch

Launch one task as a user `systemd` unit named `vinaya-task-<issue>`, with
memory caps. A unit never sources the shell profile, so every variable the
loop needs is set explicitly on the command line:

```bash
ssh dev@<vps> "bash -ic 'systemd-run --user --unit=vinaya-task-<issue> \
  --working-directory=<checkout> \
  -p MemoryHigh=1500M -p MemorySwapMax=1500M -p MemoryMax=2200M \
  --setenv=PATH=\"\$PATH\" \
  --setenv=VINAYA_LOG_TOKEN=\"\$VINAYA_LOG_TOKEN\" \
  --setenv=VINAYA_LINUX_SANDBOX_ALLOW_UNIX_SOCKETS=1 \
  --setenv=CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 \
  --setenv=BASH_DEFAULT_TIMEOUT_MS=900000 \
  --setenv=BASH_MAX_TIMEOUT_MS=1800000 \
  bun apps/cli/src/index.ts task run <tranche> <n> --agent claude'"
```

The model comes from the task Issue's agent class; the launch command does
not choose it.

## 4. Watch

Run `task status` on the box itself. The Mac shows a driver running on the
VPS as absent, because it looks for a local process.

```bash
ssh dev@<vps> "bash -ic 'cd <checkout> && bun apps/cli/src/index.ts task status <tranche> <n>'"
```

The driver log is under the runtime directory:
`~/.vinaya/runtime/<owner>-<repo>/tasks-execution/<issue>/output/driver.log`.

```bash
ssh dev@<vps> "bash -ic 'tail -f ~/.vinaya/runtime/<owner>-<repo>/tasks-execution/<issue>/output/driver.log'"
```

A healthy start logs `Developer starting round 1`.

## 5. Failures and recovery

- `sandbox could not run a probe command` — the opt-in variable
  `VINAYA_LINUX_SANDBOX_ALLOW_UNIX_SOCKETS=1` did not reach the unit. Stop the
  unit (`systemctl --user stop vinaya-task-<issue>`), check the `--setenv`
  lines, and launch again.
- Pauses and rulings work as on the Mac: post the ruling, then run the
  resume command `task status` prints for the paused task, launched as a
  `vinaya-task-<issue>` unit with the same caps and variables as step 3.
- A hand commit made over plain `ssh` (no `bash -ic`) has no log token, so its
  log events stay queued. Drain them with `log send` under `bash -ic`:

  ```bash
  ssh dev@<vps> "bash -ic 'cd <checkout> && bun apps/cli/src/index.ts log send'"
  ```
