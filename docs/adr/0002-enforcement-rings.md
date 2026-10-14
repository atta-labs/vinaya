# 0002. Enforcement rings

**Status:** Accepted

**Date:** 2026-08-14

## Context

Vinaya governs work that agents do on their own. An agent follows a written rule most of the time, but not under context pressure: a pull request once satisfied exactly the sections its checker verified and dropped the two it did not. A rule that exists only as prose will eventually be broken by an honest agent.

Not every writer passes through the same place. An agent commits and pushes from its own machine, where git hooks can refuse an action before it leaves. A human using the forge's web interface, another tool, or an older piece of history never passes through those hooks. Drift can also appear after a merge, for example a branch that was pushed and abandoned or a push that reached the default branch directly.

## Decision

We will run every obligation that would otherwise depend on an agent following instructions as a deterministic check, and place each check at the earliest point that can host it, in three rings that are always on.

Ring 0 is the local git hooks: every commit and push runs the registered checks before anything reaches the forge. Ring 1 is the forge's branch rules: the identical checks re-run as CI on every pull request, and merge is blocked while any is red. Ring 2 is scheduled audits after merge: drift is reported as findings regardless of who or what wrote it.

The same check implementations run at ring 0 and ring 1, so the local gates and CI cannot disagree. The `rings` setting in `vinaya.config.json` never turns a ring off; each of its two flags only opts out of one narrow, non-security-critical slice, and neither flag ever disables detection of a direct push to the default branch.

## Considered options

- Written instructions alone. An agent reads the rules and is trusted to follow them. This costs nothing to build, but the founding observation above shows that it fails silently under context pressure.
- CI alone. Checks run only on the pull request. This catches every writer, but an agent learns of a violation only after it has published, and every mistake becomes a visible red build instead of a refusal it can fix in its own session.
- Local hooks alone. Violations die on the agent's machine, but the web interface, other tools and humans bypass the hooks entirely, and nothing detects drift after merge.
- Three rings that run the same checks at the hook, at the forge and after merge. This is the chosen option: each ring covers the writers the previous one cannot reach.

## Consequences

An agent's invalid commit or push is refused in its own session, with the exact error, so it corrects itself without anyone looking. A red pull request on a gated rule now points to a gate defect rather than an agent failure. Drift from any writer, including history that predates the gates, is surfaced on a schedule rather than in the middle of a run.

Every new obligation must be written as a check that runs identically in two places, and every check must decide from parsed structure rather than from prose. Adopters cannot switch a ring off when it gets in their way; the only sanctioned way to silence a core check is to replace it with an explicit no-op check.

## Where it is applied

The ring model and every check behind it are listed in `aeg-root/enforcement.md`. Ring 0 runs through the hooks in `.vinaya/hooks` (`pre-commit`, `commit-msg`, `pre-push`). Ring 1 runs through `.github/workflows/vinaya-checks.yml` and `.github/workflows/vinaya-body-checks.yml`. Ring 2 runs through the scheduled jobs in `.github/workflows/vinaya-archivist.yml`. The `rings` block of `vinaya.config.json` holds the two opt-out flags, and `AGENTS.md` describes the rings for every adopter.
