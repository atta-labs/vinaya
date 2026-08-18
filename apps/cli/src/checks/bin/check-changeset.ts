#!/usr/bin/env bun

/**
 * Core check: changeset. A diff that changes a publishable package's shipped
 * source must ADD a `.changeset/*.md` entry, or the change merges and is never
 * published — it reaches no adopter, which for a fix is the entire point.
 * Nothing in the previously-registered checks asked for this; the gap was
 * found by a human on a second review round (atta-labs/vinaya#122's own PR).
 *
 * Two guards that are easy to get wrong, both measured while building this:
 *
 *   - **Added by this diff, not merely present.** `.changeset/` normally holds
 *     unreleased entries from earlier merged PRs — three, when this was
 *     written — so a presence test passes every PR whenever the release queue
 *     is non-empty.
 *   - **Only in repos that publish via changesets.** An adopter repo, and
 *     every fixture repo in this suite, has no `.changeset/config.json`; there
 *     is nothing to enforce and the check must stay silent rather than
 *     demanding a file the repo's release process does not use.
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

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    return ''
  }
}

function changedFiles(ref: string): string[] {
  return git(['diff', '--name-only', `${ref}...HEAD`])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

function main(): void {
  // Repos that do not publish via changesets have nothing to enforce.
  if (!existsSync(`${CHANGESET_DIR}/config.json`)) process.exit(0)

  const base = process.env.BASE_SHA || 'origin/main'
  let changed = changedFiles(base)
  if (changed.length === 0) changed = changedFiles('main')

  // Ring 0 runs before the commit exists, so a changeset staged in THIS commit
  // is absent from the range and the check would refuse the very commit that
  // satisfies it. Measured: it blocked its own introducing commit.
  const staged = git(['diff', '--name-only', '--cached'])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  changed = [...new Set([...changed, ...staged])]

  if (changed.length === 0) process.exit(0)

  const shipped = changed.filter((p) => SHIPPED_PREFIXES.some((pre) => p.startsWith(pre)) && !isTestPath(p))
  if (shipped.length === 0) process.exit(0)

  const added = changed.filter(
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
