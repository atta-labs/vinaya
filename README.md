<!-- logo: figlet "ANSI Shadow" — regenerate with:  figlet -f "ANSI Shadow" "VINAYA" -->
```
██╗   ██╗██╗███╗   ██╗ █████╗ ██╗   ██╗ █████╗
██║   ██║██║████╗  ██║██╔══██╗╚██╗ ██╔╝██╔══██╗
██║   ██║██║██╔██╗ ██║███████║ ╚████╔╝ ███████║
╚██╗ ██╔╝██║██║╚██╗██║██╔══██║  ╚██╔╝  ██╔══██║
 ╚████╔╝ ██║██║ ╚████║██║  ██║   ██║   ██║  ██║
  ╚═══╝  ╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝   ╚═╝   ╚═╝  ╚═╝
```

<div align="center">

# The engineering harness for software teams

### One governed loop for your agents to plan, build, review and improve.

[![npm](https://img.shields.io/npm/v/@attalabs/vinaya?style=for-the-badge&label=%40attalabs%2Fvinaya&color=CB3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/@attalabs/vinaya)

![Claude Code](https://img.shields.io/badge/Claude_Code-D97757?style=flat-square)
![Codex](https://img.shields.io/badge/Codex-000000?style=flat-square)

**[vinaya.attalabs.dev](https://vinaya.attalabs.dev)** — docs, CLI reference and roadmap

</div>

---

> **An instruction is a probability. A gate is a guarantee.**

A team that ships with coding agents writes rules: in a prompt, a rules file, a role description.
Rules are followed most of the time, which is what makes them dangerous.

Vinaya is the part that runs when the rules file is ignored. You hand it a planned task. It runs a
coding agent, has fresh agents review the result, and refuses — by machine, before the fact —
every step that would break a guarantee. A person merges.

## Quick start

```bash
npx @attalabs/vinaya quickstart   # plug in: hooks, CI workflow, starter config, a demo break, push
vinaya eject                      # unplug: removes exactly what quickstart installed, nothing else
```

Prefer to go step by step? `vinaya init` prints the full diff of what it will install and waits for
your confirmation. `vinaya --help` lists every command.

## How it works

1. **Install it.** One command puts the harness into your repository: git hooks, a CI workflow
   and a starter `vinaya.config.json`.
2. **Plan the work.** Product work becomes tasks, each with a frozen brief that says exactly what
   to build.
3. **Agents build and review.** A coding agent builds each task; fresh agents review it; every gate
   runs on the exact change.
4. **A person merges.** Nothing merges until the gates pass and a person merges it. Every governed
   act lands in the Log.

## What holds

Checks run in three rings, always on.

| Ring | Where | What it does |
|------|-------|--------------|
| **0** | Your machine | Git hooks run every check at commit and push, before anything reaches the forge. |
| **1** | The forge | The identical checks run again on every pull request and Issue. Red blocks the merge. |
| **2** | After merge | Scheduled audits surface drift: direct pushes to `main`, dead branches, docs that fell behind. |

Inside those rings, every run holds the same guarantees, whatever process drives it:

- A stated fact is recomputed, never trusted.
- A change stays inside its declared scope.
- A stopped run always says why, and who must act.
- An agent can never rule, approve or merge.
- Every governed act is kept in the Log.

**The honest limit:** these are structural guarantees, not judgment guarantees. Vinaya proves a
review happened and is current; it cannot prove anyone thought hard.

## Five features, one harness

| | Feature | What you get |
|---|---------|--------------|
| 01 | **Log** | Every check, review and decision written down as it happens, with who made it. Plug in your own log server. |
| 02 | **Telemetry** | The same events, counted per milestone: time per task, what reviewers caught, how often the checks said no. |
| 03 | **Studio** | A live dashboard of every task, check and review, plus the reports. |
| 04 | **Self-improvement** | The Improver reads the reports and proposes changes to the process. A person approves. |
| 05 | **Configuration** | One file, `vinaya.config.json`, turns the harness on: process, agents, forge, log and gates. |

```jsonc
// vinaya.config.json — your checks sit beside ours
{
  "checks": {
    "acme/secret-scan": { "run": "./scripts/vinaya-checks/secret-scan.ts", "scope": "full" }
  }
}
```

## One harness, any process

The harness is generic and never names a process. A process is a way of working: its roles, its
unit of work, its review rules and its own checks. It plugs into the harness through one contract,
giving the harness its roles (each with its doctrine, grants and tools), its loop, its checks, its
policies and its section of the configuration file.

The harness holds the loop to one promise: a task goes in, and out comes either a pull request
ready to merge, or a stop that says why and who must act. Everything inside the loop — rounds,
reviewers, retries — is the process's own business. The harness loads the process, runs its loop,
runs the gates, enforces each role's grants and keeps the Log.

The harness and the default process ship together in one package, `@attalabs/vinaya`.

## The Vinaya process

**The Vinaya process** is the default process, and it plugs in through the same contract anyone's
would:

1. **Thinking** — the Architect turns product work into one milestone.
2. **Planning** — the Planner writes every task as an Issue.
3. **Executing** — agents build and review in parallel; every gate runs.
4. **Self-improvement** — a report shows where time went and proposes what to fix next.

Three ways to plug in:

- **Adopt the default.** Use the Vinaya process end to end. Replace any check, override any role.
- **One task at a time.** Keep your own planning. Hand in one planned task; get back a reviewed
  change ready for a human merge, or a recorded pause that says why.
- **Write your own process.** Declare its loop, meet the harness's process contract, and it runs on the same harness.

## Who it's for

- **The engineer** — you define the milestone and ground it in tasks. Agents write and review. You control the merge.
- **The tech lead** — your standards become checks every pull request must pass.
- **The founder** — every feature lands through one process, so you can still answer why it shipped.

## What it runs on

- **A machine you choose** — laptop, workstation or server. No hosted service.
- **A git forge** — required. GitHub first.
- **Your agents** — Claude Code and Codex, under the subscription login already on the machine. Never an API key.
- **Atta Engine** underneath — the generic workflow runtime: checkpoints, halt and resume, recovery. It holds no Vinaya policy.

## What it is not

Not a merge button — merging stays a person's act. Not a planner — planning belongs to the process.
Not a workflow language — Atta Engine is the runtime. Not a judge of quality — it proves structure.

## This repository

Vinaya is built with Vinaya: every change here is an Issue run through its own loop and gates.
The repository keeps the same split as the product: the harness on one side, the Vinaya process on
the other, and the command line, the website and the Log server as apps.

```bash
bun install
bunx turbo typecheck build
bunx biome check .
```

Working in this repo as an agent? Start at [`AGENTS.md`](AGENTS.md).

## License

[`@attalabs/vinaya`](apps/cli/LICENSE) is source-available under [FSL-1.1-ALv2](https://fsl.software)
from `0.35.0`; `0.34.0` and earlier stay Apache-2.0.

- Use and modify Vinaya freely, including inside your own company.
- Do not offer Vinaya, or something substantially similar built from it, as a commercial product or service.
- Each release becomes Apache-2.0 two years after it ships.

The exact terms are in [LICENSE](apps/cli/LICENSE); where this summary and the license differ, the
license wins. The [root `LICENSE`](LICENSE) lists which directories fall under which terms.

<div align="center">

Built by **[Dani Estevez](https://github.com/daniboomerang)** · an **[AttaLabs](https://attalabs.dev)** product

</div>
