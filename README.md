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

# Vinaya — the development harness

### Agents write code. **Vinaya ships software.**

Every brief, every review, every merge runs as code, on your forge — whether the hand on the
keyboard is yours or an agent's.

![status](https://img.shields.io/badge/status-live-2E8B57?style=for-the-badge)
[![npm](https://img.shields.io/npm/v/@attalabs/vinaya?style=for-the-badge&label=%40attalabs%2Fvinaya&color=CB3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/@attalabs/vinaya)

![Bun](https://img.shields.io/badge/Bun-000000?style=flat-square&logo=bun&logoColor=white)
![Turborepo](https://img.shields.io/badge/Turborepo-EF4444?style=flat-square&logo=turborepo&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Biome](https://img.shields.io/badge/Biome-60A5FA?style=flat-square&logo=biome&logoColor=white)
![Claude Code](https://img.shields.io/badge/Claude_Code-D97757?style=flat-square)
![Codex](https://img.shields.io/badge/Codex-000000?style=flat-square)
![Gemini CLI](https://img.shields.io/badge/Gemini_CLI-8E75B2?style=flat-square)

**[vinaya.attalabs.dev](https://vinaya.attalabs.dev)** · **[Docs](https://vinaya.attalabs.dev/docs/reference)** · **[CLI reference](https://vinaya.attalabs.dev/docs/cli)** · **[Config](https://vinaya.attalabs.dev/config)** · **[Studio](https://vinaya.attalabs.dev/the-studio)** · **[Roadmap](https://vinaya.attalabs.dev/roadmap)**

</div>

---

## The claim

Coding agents ship fast and leave a mess nobody can answer for. Vinaya doesn't slow the agent
down — it makes the agent answer to the same process a person would: a brief before a line of
code, a small reviewable pull request, a CI gate that means what it says, and a permanent record
of what shipped and why. **The hook on your laptop and the required check in CI are the same
code.** Nothing gets to main that didn't pass both.

This isn't a rules file an agent can politely ignore on a bad day. It's deterministic checks that
refuse the commit, refuse the push, refuse the merge — before the mess exists.

## What you get back

- **Readable issues before any code.** Every task is scoped and arguable while changing the scope
  is still cheap — not discovered after 800 lines of diff.
- **Small PRs you can actually review.** One issue, one branch, one pull request. No 40-file
  drive-by refactors riding along with the fix you asked for.
- **Your CI, your checks, beside ours.** Vinaya generates its own workflows and never touches
  yours. Add `acme/licence-header` next to `brief-shape` and `review-gate` — it's your YAML the
  moment `init` writes it.
- **Your GitHub, perfectly structured.** Milestone → Issues → branch → pull request → review → CI
  → merged. One shape, every time, whether an agent or a person drove it.

## Three rings. The first two run identical code.

| Ring | Where | What it does |
|------|-------|---------------|
| **Ring 0** | Your machine | Git hooks refuse a commit that doesn't build, a push that lands on `main`, a PR that's missing what a reviewer needs — before any of it reaches GitHub. |
| **Ring 1** | The forge | The exact same checks run again in CI. Clean, or it doesn't merge. Nobody skips ring 0 by pushing from a machine that never ran the hook. |
| **Ring 2** | Audits | Scheduled sweeps catch drift the first two rings never watched — direct pushes to `main`, dead branches, documentation that fell behind the decisions it was meant to follow. |

## The Vinaya Log

Every dispatch, every gate result, every forge write, every token spent — one typed, append-only
log, one schema, one sink. Not scattered `console.log` calls: a versioned envelope
(`meta`/`subject`) on every line, and a closed set of event families —
`dispatch`, `dev_review_loop`, `gate`, `operation`, `usage`, `role_attempt`, `handoff`, `effect` —
so a reader can reconstruct exactly what an agent did, when, under whose authority, and how many
tokens it burned doing it. No family invents its own shape; no event ships without knowing which
task, which round, which role it belongs to.

That's the difference between "the agent said it passed" and a record you can actually audit.

## Bring your own agent

Claude Code, Codex, Gemini CLI — keep the one you already use. Vinaya checks the merge,
not the model.

- **Claude Code** gets a native `/vinaya <role>` command and a `Stop` hook that keeps a session
  honest about what it actually did.
- **Codex** and **Gemini CLI** get the same doctrine through their own native command surfaces —
  one source of truth, never a copy baked into a vendor-specific file.
- Every role also ships as a portable [Agent Skill](https://vinaya.attalabs.dev/docs/reference),
  discovered natively by anything that scans `.agents/skills/` — Codex, Antigravity, Grok Build.
- `vinaya dispatch` runs any of them headless, attributed, timed, and logged — the same command
  whether it's kicking off a Developer or a Reviewer.

Vinaya doesn't care which model wrote the diff. It cares whether the diff earned its merge.

## Zero lock-in

```bash
npx @attalabs/vinaya init      # in — hooks, CI workflow, starter config, nothing destructive
vinaya eject                   # out — removes exactly what init installed, nothing else
```

`init` prints the complete diff of everything it's about to do and waits for your confirmation.
`vinaya.config.json` is the one file: your gates, your checks, your agents, your roles. Vinaya
ships as the default — nothing you add or replace ever touches a second file.

## Layout

```
vinaya/
├── apps/
│   └── cli/                  # Vinaya CLI (@attalabs/vinaya)
├── packages/
│   ├── aeg-core/             # Pure gate evaluators
│   ├── aeg-forge-state/      # Forge-derived tranche/task state
│   ├── aeg-types/            # Shared types
│   ├── sources/              # State and doctrine sources
│   └── typescript-config/    # Shared TypeScript configs
└── aeg-root/                 # AEG doctrine
```

## Tooling

Bun + Turborepo, Biome for formatting and linting, TypeScript in strict mode.

```bash
bun install
bunx turbo typecheck
bunx turbo build
bunx biome check .
```

## Docs

- **[vinaya.attalabs.dev](https://vinaya.attalabs.dev)** — the pitch, the lifecycle, why this
  beats a rules file
- **[Reference](https://vinaya.attalabs.dev/docs/reference)** — every role, contract, hook, and
  check, read live from this repo's own doctrine
- **[CLI](https://vinaya.attalabs.dev/docs/cli)** — the full command reference
- **[Config](https://vinaya.attalabs.dev/config)** — `vinaya.config.json`, end to end
- **[Studio](https://vinaya.attalabs.dev/the-studio)** — the dashboard over your tranches and tasks
- **[Roadmap](https://vinaya.attalabs.dev/roadmap)**

## License

The five packages this repository publishes to npm — the Vinaya CLI
([`@attalabs/vinaya`](apps/cli/LICENSE)) and the engine packages it ships,
[`@attalabs/aeg-core`](packages/aeg-core/LICENSE),
[`@attalabs/aeg-forge-state`](packages/aeg-forge-state/LICENSE),
[`@attalabs/aeg-types`](packages/aeg-types/LICENSE) and
[`@attalabs/vinaya-sources`](packages/sources/LICENSE) — are source-available under the
[Functional Source License, Version 1.1, with an Apache-2.0 future license](https://fsl.software)
(`FSL-1.1-ALv2`), from version `0.35.0`. Versions `0.34.0` and earlier were released under
Apache-2.0 and stay Apache-2.0.

What that means for you:

- You can use and modify Vinaya freely, including at work, inside your own company.
- You may not offer Vinaya, or anything substantially similar built from it, to others as a commercial product or service. The exact terms are in [LICENSE](apps/cli/LICENSE); where this summary and the license differ, the license wins.
- Each released version becomes `Apache-2.0` on the second anniversary of its release.

The `@attalabs/vinaya` tarball also carries the `aeg-root/` doctrine and the `studio-standalone/`
dashboard, and from version `0.35.0` both are distributed under the same terms as the CLI, except
the bundled third-party dependencies, which keep their own licenses, as does the third-party code
the CLI's `dist/` bundle includes. All other code and content in this repository, meaning what none
of the five packages distributes, is copyright Daniel Estevez, all rights reserved. The
[root `LICENSE`](LICENSE) lists which directories fall under which terms.

<div align="center">

Built by **[Dani Estevez](https://github.com/daniboomerang)** · an **[AttaLabs](https://attalabs.dev)** product

</div>
