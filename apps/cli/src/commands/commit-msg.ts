// `vinaya commit-msg` — the `commit-msg` hook's invocation target.
//
// A git `commit-msg` hook receives the commit-message file's path as `$1`
// and, when git knows the commit's origin, a source keyword as `$2`
// (`message`, `template`, `merge`, `squash`, `commit` — see githooks(5)).
// This validates the message file's FIRST LINE against this repo's
// `Type(scope): Description` convention — never a staged diff, which is what
// `pre-commit`/`pre-push` validate instead.
//
// The type vocabulary is `@attalabs/aeg-core`'s `COMMIT_TYPE_STYLE`/
// `COMMIT_TYPES` — the same list `checkForgeTitle` enforces on PR/Issue
// titles. One list, every call site (including this file's own error text);
// never a second copy here (Issue #63).
//
// Source `merge` is skipped outright: a merge commit's message is written by
// git itself (`Merge branch '…'`, `Merge pull request #N from …`), not by
// the person running the command, so holding it to an authored-message
// convention would refuse a message nobody typed. `git merge`/`git pull`
// pass `$2=merge` for exactly this case (githooks(5)); every other source
// keyword names an authored message and is validated normally.

import { readFileSync } from 'node:fs'
import { COMMIT_TYPE_STYLE, COMMIT_TYPES } from '@attalabs/aeg-core'

export function commitMsgCommand(args: string[]): void {
  const [messageFile, source] = args
  if (!messageFile) {
    process.stderr.write('Usage: vinaya commit-msg <message-file> [source]\n')
    process.exitCode = 2
    return
  }

  if (source === 'merge') return

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
