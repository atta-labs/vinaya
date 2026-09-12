#!/usr/bin/env node
/**
 * task-run-v1 20, O5 — prints the repo-root-relative paths of every file
 * changed since the remote base, one per line, for the pre-push hook's
 * Biome step. Shares `resolveRemoteBase`/`changedFilesSinceRemoteBase` with
 * `pre-push-select-tests.ts` (O6) so "changed since the remote base" is
 * computed identically for both — never a second, hand-written `git diff`
 * in the generated shell that could quietly drift from the TypeScript one.
 */
import { changedFilesSinceRemoteBase } from './remote-base.js'

for (const file of changedFilesSinceRemoteBase(process.cwd())) process.stdout.write(`${file}\n`)
