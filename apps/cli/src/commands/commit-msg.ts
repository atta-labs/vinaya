// `vinaya commit-msg` — the `commit-msg` hook's invocation target.
//
// A git `commit-msg` hook receives exactly one parameter: the commit-message
// file's path (githooks(5)). The source keyword (`message`, `merge`, …) belongs
// to `prepare-commit-msg`, so a second argument, if a hook script forwards one,
// is never read here. This validates the message file's FIRST LINE against
// this repo's `Type(scope): Description` convention — never a staged diff,
// which is what `pre-commit`/`pre-push` validate instead.
//
// The type vocabulary is `@attalabs/aeg-core`'s `COMMIT_TYPE_STYLE`/
// `COMMIT_TYPES` — the same list `checkForgeTitle` enforces on PR/Issue
// titles. One list, every call site (including this file's own error text);
// never a second copy here.
//
// A merge commit is skipped outright: its message is written by git itself
// (`Merge branch '…'`, `Merge commit '…' into …`), not by the person running
// the command. Git recognises it by the merge in progress — `MERGE_HEAD`
// exists while the hook runs — so that is what is checked, resolved with
// `git rev-parse --git-path` because `.git` is a file in a linked worktree.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { COMMIT_TYPE_STYLE, COMMIT_TYPES } from '@attalabs/aeg-core'

function mergeInProgress(): boolean {
  try {
    const marker = execFileSync('git', ['rev-parse', '--git-path', 'MERGE_HEAD'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    return marker !== '' && existsSync(marker)
  } catch {
    return false
  }
}

export function commitMsgCommand(args: string[]): void {
  const [messageFile] = args
  if (!messageFile) {
    process.stderr.write('Usage: vinaya commit-msg <message-file>\n')
    process.exitCode = 2
    return
  }

  if (mergeInProgress()) return

  const firstLine = readFileSync(messageFile, 'utf-8').split('\n', 1)[0] ?? ''

  if (COMMIT_TYPE_STYLE.test(firstLine)) return

  process.stderr.write(
    `vinaya commit-msg: "${firstLine}" doesn't match this repo's commit convention.\n` +
      'Expected `Type: Description` or `Type(scope): Description`, where Type is one of ' +
      `${COMMIT_TYPES.join(', ')} — start-case, a colon, a space, then the description.\n` +
      'Example: Fix(cli): Refuse a malformed commit message\n'
  )
  process.exitCode = 1
}
