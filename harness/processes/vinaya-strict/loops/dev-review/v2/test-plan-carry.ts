import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, join, normalize } from 'node:path'

/**
 * A Test Plan command's pass carried from an earlier head of the same branch to a later one.
 *
 * The ready push reuses a command's pass only at the exact head and tree it ran on, so every Developer fix re-ran
 * every Test Plan command, even one whose tests the fix cannot reach. A pass carries forward only when all of these
 * hold:
 * - the command is a plain `bun test` over named files or folders (optionally after one `cd <folder> &&`);
 * - the earlier head is an ancestor of the new one;
 * - the repository's own test selection, walking the full import closure from the earlier head to the new one,
 *   names no test under the command's files and falls back to no "run everything" scope.
 * Anything else runs the command again.
 */

/** The test files or folders a Test Plan command runs, repository-relative, or `null` when its shape is not one. */
export function testPlanTargets(command: string, repoRoot: string): string[] | null {
  const parts = command.split('&&').map((part) => part.trim())
  if (parts.length > 2) return null
  let folder = ''
  if (parts.length === 2) {
    const cd = /^cd\s+(\S+)$/.exec(parts[0] as string)
    if (!cd) return null
    folder = cd[1] as string
  }
  const tokens = (parts[parts.length - 1] as string).split(/\s+/)
  if (tokens[0] !== 'bun' || tokens[1] !== 'test') return null
  if (/[|;<>$`*?]/.test(command)) return null
  const targets: string[] = []
  for (const token of tokens.slice(2)) {
    if (token.startsWith('-')) continue
    const path = normalize(join(folder, token))
    if (isAbsolute(path) || path.startsWith('..') || !existsSync(join(repoRoot, path))) return null
    targets.push(path.replace(/\/$/, ''))
  }
  return targets.length > 0 ? targets.sort() : null
}

/** What the repository's selection said about the change from the earlier head to the new one. */
export type CarrySelection = { tests: string[]; fallbacks: string[] }

/** Whether a pass of a command over `targets` still stands after a change whose selection is `selection`. */
export function passCarries(targets: readonly string[], selection: CarrySelection | null): boolean {
  if (selection === null || selection.fallbacks.length > 0) return false
  return !selection.tests.some((test) => targets.some((target) => test === target || test.startsWith(`${target}/`)))
}

/** The cache key of a command's most recent pass on any head of this worktree. */
export function carryKey(command: string, repoRoot: string): string {
  return `carry:${createHash('sha256').update(`${repoRoot}\n${command}`).digest('hex')}`
}

/** The repository's selection for `base`..`head`, through its own command line, walking the full import closure. */
export function repositorySelectionBetween(repoRoot: string, base: string, head: string): CarrySelection | null {
  const script = join(repoRoot, 'scripts', 'test-suites', 'repository-selection.ts')
  if (!existsSync(script)) return null
  try {
    const out = execFileSync('bun', [script, '--base', base, '--head', head], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000
    })
    const plan = JSON.parse(out) as {
      required?: { test: string }[]
      fallbacks?: { id: string; tests?: string[] }[]
    }
    return {
      tests: (plan.required ?? []).map((r) => r.test),
      fallbacks: (plan.fallbacks ?? []).filter((f) => (f.tests ?? []).length > 0).map((f) => f.id)
    }
  } catch {
    return null
  }
}

/** Whether `ancestor` is an ancestor of `head` in this repository. */
export function isAncestorCommit(repoRoot: string, ancestor: string, head: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, head], { cwd: repoRoot, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** A command's last recorded pass: the head it ran on and its output. */
export type CarriedRecord = { head?: string; output: string }

/**
 * The pass of `command` carried to `head` from the last head it passed on, or `null` when it must run again. `select`
 * and `ancestor` default to the repository's own selection and git; a test hands in its own.
 */
export function carriedPass(input: {
  command: string
  repoRoot: string
  head: string
  record: CarriedRecord | undefined
  select?: (base: string, head: string) => CarrySelection | null
  ancestor?: (ancestor: string, head: string) => boolean
}): { output: string; from: string } | null {
  const earlier = input.record?.head
  if (!input.record || !earlier || earlier === input.head) return null
  const targets = testPlanTargets(input.command, input.repoRoot)
  if (!targets) return null
  const ancestor = input.ancestor ?? ((a, h) => isAncestorCommit(input.repoRoot, a, h))
  if (!ancestor(earlier, input.head)) return null
  const select = input.select ?? ((b, h) => repositorySelectionBetween(input.repoRoot, b, h))
  if (!passCarries(targets, select(earlier, input.head))) return null
  return {
    output: input.record.output,
    from: `the pass at \`${earlier.slice(0, 12)}\`, whose tests nothing changed since then reaches`
  }
}
