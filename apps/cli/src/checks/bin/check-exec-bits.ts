#!/usr/bin/env bun

/**
 * Core check: exec-bits. Refuses a staged executable whose
 * INDEX mode is not `100755`, before it leaves the machine.
 *
 * Why this is a check and not a convention: the runner spawns a check bin
 * directly, never through a shell, so a bin committed `100644` is not a
 * check that misbehaves — it is a check that cannot start at all, and the
 * failure surfaces on someone else's machine (or a CI runner) as an opaque
 * EACCES long after the commit that caused it. The exec bit is also the one
 * file property a working tree can carry correctly while the index carries
 * it wrong: `chmod +x` on disk changes nothing git will ship. So the mode
 * read here is `git ls-files -s`'s — the index's own — never `fs.statSync`'s.
 *
 * Two independent signals, either sufficient, because neither alone covers
 * the real cases: a path under a `checks/bin/` directory (what the runner
 * spawns), and a file whose first line starts with `#!` (anything meant to
 * be executed directly, wherever it lives). A staged script with a shebang
 * outside `checks/bin/` is exactly as broken and is caught by the second.
 *
 * A symlink stages as mode `120000` and fails — intended. The runner spawns
 * the path it is given; a symlink in that position is not an executable
 * check bin, and passing it would be this check declaring a file runnable
 * that is not.
 *
 * scope: diff — only staged/changed files are judged, never the whole tree.
 * ring 0: an unexecutable bin is refused on the machine that staged it.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { CHECK_SCHEMA_VERSION, emitCheckError } from '../contract'
import { repoRoot, resolveChangedFiles } from '../../lib/diff-evidence'

const CHECK_NAME = 'exec-bits'
const EXECUTABLE_MODE = '100755'

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    return null
  }
}

/**
 * The index mode git records for `path`, or `null` when git reports nothing
 * for it (untracked, or deleted in this diff). `git ls-files -s` prints
 * `<mode> <object> <stage>\t<path>`.
 */
function indexMode(path: string): string | null {
  const out = git(['ls-files', '-s', '--', path])
  if (out === null || out === '') return null
  const mode = out.split(/\s+/)[0] ?? ''
  return /^\d{6}$/.test(mode) ? mode : null
}

function hasShebang(path: string): boolean {
  try {
    return readFileSync(path, 'utf8').startsWith('#!')
  } catch {
    return false
  }
}

/** A path git would have to mark executable: it lives under a `checks/bin/` directory, or its own first line is a shebang. */
function shouldBeExecutable(absPath: string, posixPath: string): boolean {
  return posixPath.includes('checks/bin/') || hasShebang(absPath)
}

function main(): void {
  const root = repoRoot()
  const changed = resolveChangedFiles()
  if (root === null || changed === null) {
    // No diff boundary at all — nothing staged to judge. Never a refusal:
    // this check reports on files a diff names, and no diff names none.
    process.stdout.write(`${CHECK_NAME}: no diff boundary resolvable — 0 file(s) judged\n`)
    process.exit(0)
  }

  const offenders: { path: string; mode: string }[] = []
  let judged = 0
  for (const abs of changed) {
    const posixPath = abs
      .slice(root.length + 1)
      .split('\\')
      .join('/')
    if (!shouldBeExecutable(abs, posixPath)) continue
    const mode = indexMode(posixPath)
    if (mode === null) continue
    judged++
    if (mode !== EXECUTABLE_MODE) offenders.push({ path: posixPath, mode })
  }

  // stdout only — this check's stderr is the CheckError JSON channel
  // (`contract.ts`'s `emitCheckError`); a plain-text line there would make
  // the runner treat this human-readable summary as malformed output.
  process.stdout.write(
    `${CHECK_NAME}: ${judged} executable file(s) judged; ${offenders.length} not ${EXECUTABLE_MODE}\n`
  )

  for (const offender of offenders) {
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: CHECK_NAME,
      severity: 'error',
      message: `${offender.path}: staged with index mode ${offender.mode}, not ${EXECUTABLE_MODE} — it will not be executable for anyone who checks this out.`,
      file: offender.path,
      agent_recovery_prompt: `Run \`git update-index --chmod=+x ${offender.path}\` and commit the mode change. A \`chmod +x\` on disk is not enough — the mode git ships is the INDEX's, and that is what this check reads.`
    })
  }

  process.exit(offenders.length > 0 ? 1 : 0)
}

main()
