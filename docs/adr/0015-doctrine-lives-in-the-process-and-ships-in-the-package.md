# 0015. Doctrine lives in the process and ships in the package

**Status:** Accepted

**Date:** 2026-11-07

## Context

Record [0008](0008-doctrine-ships-in-the-package.md) ships the doctrine inside the installed `@attalabs/vinaya` package and resolves it with `vinaya doctrine`. When it was written the doctrine sat in one root folder, `aeg-root/`, that the package copied whole, and every reader of the doctrine joined that folder with a role name or a file name.

Record [0014](0014-the-kernel-and-the-process-sit-under-harness.md) then gave the Vinaya process its own folder, `harness/processes/vinaya-strict/`, with a folder per role under `thinking/`, `executing/` and `retrospecting/`. A role's doctrine is the process's text, so a separate root folder for it is a second home that names a retired term, and its readers' habit of joining a folder with a role name stops working once a role's file is `executing/code-reviewer/doctrine.md` rather than `roles/reviewer.md`.

## Decision

We will keep the doctrine in the Vinaya process's own folders: each role's doctrine in its role folder as `doctrine.md`, the process-wide pages under `doctrine/`, and the templates under `artifacts/templates/`. One committed doctrine map, `harness/processes/vinaya-strict/tools/doctrine/doctrine-map.ts`, names every doctrine file by its logical key, its source path relative to the process folder, its role or template name, and whether it ships, and every reader finds a doctrine file through that map. The package ships the doctrine under its own `vinaya-strict/` folder, each file at the same process-relative path, and `vinaya doctrine` still resolves and prints it.

## Considered options

- Keep the root doctrine folder beside the process. Nothing moves, but the doctrine has a second home outside the process it governs, and a reader still cannot tell a role's file from its role folder.
- Move the files and let each reader find them by its own folder rule. The files land in the process, but every reader carries its own copy of the layout, and the copies drift.
- Move the files into the process and name every file once, in a map every reader reads. This is the chosen option: the source tree and the installed package hold the same relative layout, links between doctrine files resolve the same way in both, and a layout change edits one list.

## Consequences

The doctrine lives where the process lives, and the installed package carries it under `vinaya-strict/`, so a repository that vendors the command line and an adopter that installs it read the same layout. A reader keyed by role name looks the role up in the map instead of joining a folder and a name. The map's logical keys keep the old layout's names, because the documentation readers key their output on them. The doctrine's version in a Log header is computed from the map's source paths, so it changes when a doctrine file changes and never when other process code changes. Record [0008](0008-doctrine-ships-in-the-package.md)'s decision that the doctrine ships in the package and is resolved by `vinaya doctrine` still holds; this record replaces it because the place it names has moved.

## Where it is applied

`harness/processes/vinaya-strict/tools/doctrine/doctrine-map.ts` is the map, and `harness/processes/vinaya-strict/tools/doctrine/resolve-doctrine.ts` resolves the doctrine root through it. `apps/cli/src/commands/doctrine.ts` is `vinaya doctrine`, which prints what the resolver finds. `apps/cli/scripts/bundle-doctrine.ts` copies the map's shipped files into the package's `vinaya-strict/` folder, which the package's `files` list names. `harness/processes/vinaya-strict/integration/log/doctrine-version.ts` computes the Log's doctrine version.
