# 0010. The portal lives in this repository

**Status:** Accepted

**Date:** 2026-10-20

## Context

The Vinaya portal is the public site that presents the harness: its documentation, its roadmap and its release figures. It was built in a separate checkout and reads the harness's own packages for the command and configuration references it renders. Those packages were consumed from the npm registry, so the site showed the last published version of the harness, never the one under review.

The portal is deployed by Vercel, which builds from a repository and a root directory and can skip a build when the push changed nothing the site depends on.

## Decision

We will keep the portal in this repository as the workspace `@vinaya/portal` under `apps/vinaya-portal`, on the root lockfile, taking the harness's packages from the workspace. Changesets ignores it, so it is never versioned or released with the CLI. Turbo caches its production build output, and a Vercel ignored-build script skips a deployment when a push changes nothing the portal or its dependencies contain.

## Considered options

- Keep the portal in its own repository, consuming the published packages. This keeps the repositories small and independent, but the site lags the harness by a release, and a change to a reference the site renders needs two pull requests in two repositories.
- Keep the portal in its own repository, consuming the harness through a git dependency or a linked checkout. This removes the lag but ties the site's build to a second repository's state and to a machine-specific link.
- Move the portal into this repository as a workspace. This is the chosen option. One pull request changes a reference and the page that renders it, and the root checks cover both.

## Consequences

The site always renders the harness at the commit it is built from, and one change can move both. The repository now holds a Next.js application, so root linting and typechecking cover it, installs are larger, and its dependencies share the root lockfile. Every push triggers a Vercel evaluation, which the ignored-build script answers cheaply, and the script relies on `turbo-ignore`, which Turborepo has deprecated in favour of `turbo query affected`; replacing it later changes only that script.

## Where it is applied

The portal is `apps/vinaya-portal`. `scripts/vercel-ignore-build.sh` is the Vercel ignored-build command, run as `bash scripts/vercel-ignore-build.sh @vinaya/portal`. `.changeset/config.json` ignores the package and `turbo.json` declares its build output and environment variables.
