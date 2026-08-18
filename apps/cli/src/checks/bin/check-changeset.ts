#!/usr/bin/env bun

/**
 * Core check: changeset. A diff that changes a publishable package's shipped
 * source must ADD a `.changeset/*.md` entry, or the change merges and is never
 * published — it reaches no adopter, which for a fix is the entire point.
 * Nothing in the previously-registered checks asked for this; the gap was
 * found by a human on a second review round (atta-labs/vinaya#122's own PR).
 *
 * Four guards, each one a measured failure of an earlier revision — see
 * `apps/cli/tests/checks/changeset-gate.test.ts`, which pins every case:
 *
 *   - **ADDED by this diff** (`--diff-filter=A`), not merely touched.
 *     `--name-only` alone also lists modified and deleted paths, so an author
 *     cleared the gate by deleting someone else's queued entry — harming the
 *     release while scoring as compliance.
 *   - **Not merely present.** `.changeset/` normally holds unreleased entries
 *     from earlier merged PRs, so a presence test passes every PR whenever the
 *     release queue is non-empty.
 *   - **Fail closed when git cannot answer.** An unresolvable base — a shallow
 *     clone, a `master`-default repo, a non-git directory — is not evidence
 *     that nothing shipped. This repo's CI is shielded by `fetch-depth: 0`;
 *     adopters are not.
 *   - **Config read from the BASE.** Otherwise a diff that deletes
 *     `.changeset/config.json` silences the gate for itself. A repo that
 *     genuinely does not publish via changesets still sees nothing.
 *
 * scope: diff — a property of the change, not of the tree.
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { CHECK_SCHEMA_VERSION, emitCheckError } from '../contract'

const CHECK_NAME = 'changeset'
const CHANGESET_DIR = '.changeset'

/** Source roots whose contents reach an adopter, by workspace. */
const SHIPPED_PREFIXES = [
  'apps/cli/src/',
  'packages/aeg-core/src/',
  'packages/aeg-forge-state/src/',
  'packages/aeg-types/src/',
  'packages/sources/src/'
]

function isTestPath(p: string): boolean {
  return p.includes('/__tests__/') || /\.(test|spec)\.tsx?$/.test(p)
}

/** `null` when git itself failed — distinct from "git answered, with nothing". */
function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    return null
  }
}

function lines(out: string | null): string[] {
  return (out ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** `null` when the ref could not be resolved at all — never an empty list. */
function changedFiles(ref: string): string[] | null {
  const out = git(['diff', '--name-only', `${ref}...HEAD`])
  return out === null ? null : lines(out)
}

function main(): void {
  // Read the guard from the BASE, not the working tree: a diff that deletes
  // `.changeset/config.json` would otherwise silence the check for itself.
  const base = process.env.BASE_SHA || 'origin/main'
  const configAtBase = git(['cat-file', '-e', `${base}:${CHANGESET_DIR}/config.json`]) !== null
  if (!configAtBase && !existsSync(`${CHANGESET_DIR}/config.json`)) process.exit(0)

  let changed = changedFiles(base)
  if (changed === null || changed.length === 0) changed = changedFiles('main')

  // Fail CLOSED when git cannot answer at all. An unresolvable base (a shallow
  // clone, a repo whose default branch is `master`, a non-git directory) is
  // not evidence that nothing shipped — treating it as such let the gate pass
  // in exactly those cases. Measured: exit 0 in a non-git dir and in a
  // `master`-default repo before this guard.
  if (changed === null) {
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: CHECK_NAME,
      severity: 'error',
      message: `Could not resolve a base to diff against (tried \`${base}\` and \`main\`), so this check cannot tell whether shipped source changed. Refusing rather than passing on no evidence.`,
      agent_recovery_prompt: `Set BASE_SHA to a ref this checkout can resolve, or fetch the base branch (CI: \`fetch-depth: 0\`), then re-run \`vinaya check ${CHECK_NAME}\`.`
    })
    process.exit(1)
  }

  // Ring 0 runs before the commit exists, so a changeset staged in THIS commit
  // is absent from the range and the check would refuse the very commit that
  // satisfies it. Measured: it blocked its own introducing commit.
  const stagedAll = lines(git(['diff', '--name-only', '--cached']))
  const stagedAdded = lines(git(['diff', '--name-only', '--diff-filter=A', '--cached']))
  changed = [...new Set([...changed, ...stagedAll])]

  const shipped = changed.filter((p) => SHIPPED_PREFIXES.some((pre) => p.startsWith(pre)) && !isTestPath(p))
  if (shipped.length === 0) process.exit(0)

  // ADDED entries only. `--name-only` alone also lists modified and deleted
  // paths, so an author cleared this gate by touching — or deleting — someone
  // else's queued changeset, harming the release while scoring as compliance.
  // Measured at the previous head: both exited 0.
  const addedInRange = lines(git(['diff', '--name-only', '--diff-filter=A', `${base}...HEAD`]))
  const added = [...addedInRange, ...stagedAdded].filter(
    (p) => p.startsWith(`${CHANGESET_DIR}/`) && p.endsWith('.md') && !p.endsWith('README.md')
  )
  if (added.length > 0) process.exit(0)

  emitCheckError({
    schema: CHECK_SCHEMA_VERSION,
    check: CHECK_NAME,
    severity: 'error',
    message:
      `This diff changes shipped source (${shipped.slice(0, 3).join(', ')}${shipped.length > 3 ? `, +${shipped.length - 3} more` : ''}) ` +
      `but adds no ${CHANGESET_DIR}/*.md entry. Without one the change merges and is never published, so it reaches no adopter.`,
    agent_recovery_prompt: `Add a ${CHANGESET_DIR}/*.md entry describing the change, then re-run \`vinaya check ${CHECK_NAME}\`. This repo publishes as one fixed version group — existing entries list every member at the same bump level; copy the most recent one's shape.`
  })
  process.exit(1)
}

main()
