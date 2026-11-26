/**
 * A read-only copy of the code at one captured revision, in a scratch folder.
 *
 * A review round gives its session this copy and nothing else, so an
 * uncommitted edit in the working tree is never read and the session has no
 * history or remote to reach. The copy is the revision's own files, made
 * non-writable; `remove` makes it writable again and deletes the whole folder.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

export interface StagedRevision {
  /** The scratch folder of the round: the copy, and whatever else the round generates, all removed together. */
  readonly root: string
  /** The read-only copy of the revision's files. */
  readonly dir: string
  /** The number of lines of a file of the copy, or `null` when the path is not a file of it. */
  lineCount(path: string): number | null
  /** Removes the whole scratch folder; safe to call twice. */
  remove(): void
}

/** The number of lines of a text: a final newline ends the last line, it does not start another. */
export function countLines(text: string): number {
  if (text.length === 0) return 0
  const parts = text.split('\n')
  return text.endsWith('\n') ? parts.length - 1 : parts.length
}

/** Stages the files of `revision` of the repository at `repoRoot` into a new scratch folder. */
export function stageRevision(repoRoot: string, revision: string, parent: string = tmpdir()): StagedRevision {
  // A revision is a full object id: anything else, an option included, is never handed to git.
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error(`cannot stage revision ${revision}: not a full commit id`)
  const root = mkdtempSync(join(parent, 'plan-review-round-'))
  const dir = join(root, 'code')
  const remove = (): void => {
    if (!existsSync(root)) return
    try {
      execFileSync('chmod', ['-R', 'u+w', root], { stdio: 'ignore' })
    } catch {
      // a folder that cannot be made writable is removed as far as it can be
    }
    rmSync(root, { recursive: true, force: true })
  }
  try {
    mkdirSync(dir)
    // The archive holds the revision's tracked files only; a failure of either side of the pipe fails the stage.
    execFileSync(
      'bash',
      [
        '-c',
        'set -o pipefail; git -C "$1" archive --format=tar "$2" | tar -x -C "$3"',
        'stage',
        repoRoot,
        revision,
        dir
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    )
    execFileSync('chmod', ['-R', 'a-w', dir], { stdio: 'ignore' })
  } catch (error) {
    remove()
    throw new Error(`cannot stage revision ${revision}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return {
    root,
    dir,
    lineCount(path) {
      const file = resolve(dir, path)
      if (!file.startsWith(dir + sep)) return null
      try {
        // A tracked symlink is not a file of the revision's tree: refuse it, and any path through one.
        if (lstatSync(file).isSymbolicLink()) return null
        if (!realpathSync(file).startsWith(`${realpathSync(dir)}${sep}`)) return null
        if (!statSync(file).isFile()) return null
        return countLines(readFileSync(file, 'utf8'))
      } catch {
        return null
      }
    },
    remove
  }
}
